import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildMergedDocument, type Choice, type Resolution, type Resolutions } from '../lib/merge';
import { splitParagraphs } from '../lib/text';
import { SAMPLE_BASE, SAMPLE_BRAND, SAMPLE_LEGAL } from '../sample';
import {
  applyAcknowledge,
  applyClaim,
  applyReassign,
  applyResolution,
  applyReturn,
  EMPTY_WORKBENCH_STATE,
  removeResolution,
  type WorkbenchState,
} from './actions';
import { handoffStatus, isHandoffLocked, type Handoff, type Handoffs } from './handoff';
import {
  canRedo as histCanRedo,
  canUndo as histCanUndo,
  createHistory,
  pushHistory,
  redo as histRedo,
  undo as histUndo,
  type History,
} from './history';

const LS_KEY = 'pr-merge-workbench:v1';

interface Persisted {
  baseText: string;
  brandText: string;
  legalText: string;
  resolutions: Resolutions;
  /** v1 早期数据没有该字段，按空交接处理 */
  handoffs?: Handoffs;
}

function sanitizeHandoffs(raw: unknown): Handoffs {
  if (!raw || typeof raw !== 'object') return {};
  const out: Handoffs = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const h = value as Partial<Handoff> | null;
    if (
      h &&
      typeof h.conflictId === 'string' &&
      typeof h.reviewer === 'string' &&
      typeof h.createdAt === 'number' &&
      typeof h.deadline === 'number' &&
      typeof h.fingerprint === 'string'
    ) {
      out[key] = h as Handoff;
    }
  }
  return out;
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (
      typeof parsed.baseText === 'string' &&
      typeof parsed.brandText === 'string' &&
      typeof parsed.legalText === 'string' &&
      parsed.resolutions !== null &&
      typeof parsed.resolutions === 'object'
    ) {
      return { ...parsed, handoffs: sanitizeHandoffs(parsed.handoffs) } as Persisted;
    }
    return null;
  } catch {
    return null;
  }
}

/** 界面刷新交接状态的节拍：剩余时限展示与超时解锁都按它重算 */
const HANDOFF_TICK_MS = 30_000;

/**
 * 工作台状态：三份文稿 + 冲突裁决 + 审校交接（裁决与交接共享同一撤销/重做历史），
 * 全部持久化到 localStorage。合并结果由纯函数 buildMergedDocument 派生，任何状态变化都会自动重算。
 */
export function useWorkbench() {
  const [persisted] = useState(loadPersisted);
  const [baseText, setBaseText] = useState(persisted?.baseText ?? SAMPLE_BASE);
  const [brandText, setBrandText] = useState(persisted?.brandText ?? SAMPLE_BRAND);
  const [legalText, setLegalText] = useState(persisted?.legalText ?? SAMPLE_LEGAL);
  const [history, setHistory] = useState<History<WorkbenchState>>(() =>
    createHistory(
      persisted
        ? { resolutions: persisted.resolutions, handoffs: persisted.handoffs ?? {} }
        : EMPTY_WORKBENCH_STATE,
    ),
  );
  // 当前时间快照：交接剩余时限与超时判定都基于它，定时刷新
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), HANDOFF_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      const payload: Persisted = {
        baseText,
        brandText,
        legalText,
        resolutions: history.present.resolutions,
        handoffs: history.present.handoffs,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      // 存储不可用（如隐私模式）时静默降级为内存态
    }
  }, [baseText, brandText, legalText, history.present]);

  const base = useMemo(() => splitParagraphs(baseText), [baseText]);
  const brand = useMemo(() => splitParagraphs(brandText), [brandText]);
  const legal = useMemo(() => splitParagraphs(legalText), [legalText]);
  const merge = useMemo(
    () => buildMergedDocument(base, brand, legal, history.present.resolutions),
    [base, brand, legal, history.present.resolutions],
  );
  const conflictById = useMemo(() => new Map(merge.conflicts.map((c) => [c.id, c])), [merge.conflicts]);

  /** 提交工作台变更；纯函数返回原引用（无变化 / 重复提交）时不产生历史记录 */
  const commit = useCallback((next: WorkbenchState, h: History<WorkbenchState>) => {
    return next === h.present ? h : pushHistory(h, next);
  }, []);

  const resolve = useCallback(
    (id: string, choice: Choice, manualText?: string) => {
      const resolution: Resolution =
        choice === 'manual' ? { choice, manualText: manualText ?? '' } : { choice };
      setHistory((h) => commit(applyResolution(h.present, id, resolution), h));
    },
    [commit],
  );

  const unresolve = useCallback(
    (id: string) => {
      setHistory((h) => commit(removeResolution(h.present, id), h));
    },
    [commit],
  );

  const claimHandoff = useCallback(
    (id: string, reviewer: string, ttlMs: number) => {
      const conflict = conflictById.get(id);
      const name = reviewer.trim();
      if (!conflict || !name) return;
      setHistory((h) => commit(applyClaim(h.present, conflict, name, Date.now(), ttlMs), h));
    },
    [commit, conflictById],
  );

  const returnHandoff = useCallback(
    (id: string) => {
      setHistory((h) => commit(applyReturn(h.present, id), h));
    },
    [commit],
  );

  const reassignHandoff = useCallback(
    (id: string, reviewer: string, ttlMs: number) => {
      const conflict = conflictById.get(id);
      const name = reviewer.trim();
      if (!conflict || !name) return;
      setHistory((h) => commit(applyReassign(h.present, conflict, name, Date.now(), ttlMs), h));
    },
    [commit, conflictById],
  );

  const acknowledgeHandoff = useCallback(
    (id: string) => {
      const conflict = conflictById.get(id);
      if (!conflict) return;
      setHistory((h) => commit(applyAcknowledge(h.present, conflict), h));
    },
    [commit, conflictById],
  );

  const undo = useCallback(() => setHistory((h) => histUndo(h) ?? h), []);
  const redo = useCallback(() => setHistory((h) => histRedo(h) ?? h), []);

  const resetSample = useCallback(() => {
    setBaseText(SAMPLE_BASE);
    setBrandText(SAMPLE_BRAND);
    setLegalText(SAMPLE_LEGAL);
    setHistory((h) =>
      Object.keys(h.present.resolutions).length === 0 && Object.keys(h.present.handoffs).length === 0
        ? h
        : pushHistory(h, EMPTY_WORKBENCH_STATE),
    );
  }, []);

  const handoffs = history.present.handoffs;

  /** 仍处于锁定状态（审校中 / 待复核）的交接数量，统计栏展示用 */
  const handoffCount = useMemo(
    () =>
      Object.values(handoffs).filter((h) =>
        isHandoffLocked(handoffStatus(h, conflictById.get(h.conflictId), now)),
      ).length,
    [handoffs, conflictById, now],
  );

  return {
    baseText,
    brandText,
    legalText,
    setBaseText,
    setBrandText,
    setLegalText,
    base,
    brand,
    legal,
    merge,
    resolutions: history.present.resolutions,
    handoffs,
    handoffCount,
    now,
    resolve,
    unresolve,
    claimHandoff,
    returnHandoff,
    reassignHandoff,
    acknowledgeHandoff,
    undo,
    redo,
    canUndo: histCanUndo(history),
    canRedo: histCanRedo(history),
    resetSample,
  };
}
