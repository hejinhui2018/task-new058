import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildMergedDocument, type Choice, type Resolutions } from '../lib/merge';
import { splitParagraphs } from '../lib/text';
import { SAMPLE_BASE, SAMPLE_BRAND, SAMPLE_LEGAL } from '../sample';
import {
  canRedo as histCanRedo,
  canUndo as histCanUndo,
  createHistory,
  pushHistory,
  redo as histRedo,
  undo as histUndo,
  type History,
} from './history';
import { applyResolution,
  assignConflict,
  claimConflict,
  confirmReview,
  DEFAULT_TIMEOUT_MS,
  emptyDoc,
  expireLocks,
  forwardConflict,
  getLock,
  HandoffError,
  migrateLegacyResolutions,
  reconcileDoc,
  returnConflict,
  unresolveConflict,
  type Handoffs,
  type ReviewerId,
  type WorkbenchDoc,
} from '../lib/handoff';
import { remapDocAfterBaseEdit } from '../lib/identity';
import type { Conflict } from '../lib/merge';

const LS_KEY = 'pr-merge-workbench:v2';
const LS_KEY_V1 = 'pr-merge-workbench:v1';
const TICK_MS = 5000;
const EMPTY_REVIEW_KEYS: ReadonlySet<string> = new Set();

export const SUGGESTED_REVIEWERS = ['编辑甲', '审校小林', '审校老周'];
export { DEFAULT_TIMEOUT_MS };

interface PersistedV2 {
  version: 2;
  baseText: string;
  brandText: string;
  legalText: string;
  doc: WorkbenchDoc;
  identity: ReviewerId;
}

interface InitialState {
  baseText: string;
  brandText: string;
  legalText: string;
  doc: WorkbenchDoc;
  identity: ReviewerId;
}

function loadInitial(): InitialState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedV2>;
      if (
        p.version === 2 &&
        typeof p.baseText === 'string' &&
        typeof p.brandText === 'string' &&
        typeof p.legalText === 'string' &&
        p.doc &&
        typeof p.doc === 'object'
      ) {
        return {
          baseText: p.baseText,
          brandText: p.brandText,
          legalText: p.legalText,
          doc: {
            resolutions: (p.doc.resolutions ?? {}) as WorkbenchDoc['resolutions'],
            handoffs: (p.doc.handoffs ?? {}) as Handoffs,
            fingerprints: (p.doc.fingerprints ?? {}) as WorkbenchDoc['fingerprints'],
          },
          identity: typeof p.identity === 'string' && p.identity ? p.identity : SUGGESTED_REVIEWERS[0],
        };
      }
    }
    // 兼容 v1：裁决按下标 id 保存，借助首次合并结果迁移到稳定 key
    const legacyRaw = localStorage.getItem(LS_KEY_V1);
    if (legacyRaw) {
      const v1 = JSON.parse(legacyRaw) as {
        baseText?: string;
        brandText?: string;
        legalText?: string;
        resolutions?: Resolutions;
      };
      if (
        typeof v1.baseText === 'string' &&
        typeof v1.brandText === 'string' &&
        typeof v1.legalText === 'string' &&
        v1.resolutions
      ) {
        const merge = buildMergedDocument(
          splitParagraphs(v1.baseText),
          splitParagraphs(v1.brandText),
          splitParagraphs(v1.legalText),
          {},
        );
        return {
          baseText: v1.baseText,
          brandText: v1.brandText,
          legalText: v1.legalText,
          doc: migrateLegacyResolutions(v1.resolutions, merge.conflicts),
          identity: SUGGESTED_REVIEWERS[0],
        };
      }
    }
  } catch {
    // 存储损坏时回退到内置示例
  }
  return {
    baseText: SAMPLE_BASE,
    brandText: SAMPLE_BRAND,
    legalText: SAMPLE_LEGAL,
    doc: emptyDoc(),
    identity: SUGGESTED_REVIEWERS[0],
  };
}

export interface ActionError {
  code: string;
  message: string;
}

/**
 * 工作台状态：三份文稿 + 按冲突稳定身份保存的裁决/交接（整体进撤销重做栈）。
 * 来源文稿变化由 reconcileDoc 对账：受影响冲突转待复核，未受影响的裁决与交接保留；
 * 该系统迁移不进撤销历史。交接超时由时钟轮询驱动，同样不进历史。
 */
export function useWorkbench() {
  const [initial] = useState(loadInitial);
  const [baseText, setBaseText] = useState(initial.baseText);
  const [brandText, setBrandText] = useState(initial.brandText);
  const [legalText, setLegalText] = useState(initial.legalText);
  const [identity, setIdentityState] = useState<ReviewerId>(initial.identity);
  const [history, setHistory] = useState<History<WorkbenchDoc>>(() =>
    createHistory(initial.doc),
  );
  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const presentRef = useRef(history.present);
  presentRef.current = history.present;

  // 定时检查交接超时
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const t = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      const payload: PersistedV2 = {
        version: 2,
        baseText,
        brandText,
        legalText,
        doc: history.present,
        identity,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      // 存储不可用（如隐私模式）时静默降级为内存态
    }
  }, [baseText, brandText, legalText, history.present, identity]);

  const base = useMemo(() => splitParagraphs(baseText), [baseText]);
  const brand = useMemo(() => splitParagraphs(brandText), [brandText]);
  const legal = useMemo(() => splitParagraphs(legalText), [legalText]);

  // 第一次构建不带 reviewKeys，用于拿到当前冲突的身份与指纹做对账
  const rawConflicts = useMemo(
    () =>
      buildMergedDocument(base, brand, legal, history.present.resolutions).conflicts,
    [base, brand, legal, history.present.resolutions],
  );

  // 底稿段落被原地改写时，把按旧 key 保存的记录平移到新 key（系统迁移，不进历史）
  const prevBaseRef = useRef(base);
  const prevConflictsRef = useRef<Conflict[] | null>(null);
  const remappedDoc = useMemo(() => {
    const oldConflicts = prevConflictsRef.current;
    if (!oldConflicts || prevBaseRef.current === base) return history.present;
    return remapDocAfterBaseEdit({
      oldBase: prevBaseRef.current,
      newBase: base,
      oldConflicts,
      newConflicts: rawConflicts,
      doc: history.present,
    });
  }, [history.present, base, rawConflicts]);

  useEffect(() => {
    prevBaseRef.current = base;
    prevConflictsRef.current = rawConflicts;
  }, [base, rawConflicts]);

  useEffect(() => {
    if (remappedDoc !== history.present) {
      setHistory((h) => (h.present === remappedDoc ? h : { ...h, present: remappedDoc }));
    }
  }, [remappedDoc, history.present]);

  // 对账（来源更新 → 待复核）与超时清理；均为系统迁移，不进撤销历史
  const upgraded = useMemo(() => {
    const reconciled = reconcileDoc(remappedDoc, rawConflicts, now);
    const expired = expireLocks(reconciled.doc, now);
    return {
      doc: expired.doc,
      reviewKeys: reconciled.reviewKeys.size > 0 ? reconciled.reviewKeys : EMPTY_REVIEW_KEYS,
      expiredKeys: expired.expired,
    };
  }, [remappedDoc, rawConflicts, now]);

  useEffect(() => {
    if (upgraded.doc !== history.present) {
      setHistory((h) => (h.present === upgraded.doc ? h : { ...h, present: upgraded.doc }));
    }
  }, [upgraded.doc, history.present]);

  const fingerprintOf = useCallback(
    (key: string): string => rawConflicts.find((c) => c.key === key)?.fingerprint
      ?? history.present.fingerprints[key]
      ?? '',
    [rawConflicts, history.present.fingerprints],
  );

  // 待复核冲突的旧裁决不参与合并（但仍保留在 doc 中供界面展示/沿用）
  const effectiveResolutions = useMemo(() => {
    if (upgraded.reviewKeys.size === 0) return upgraded.doc.resolutions;
    const out: Resolutions = { ...upgraded.doc.resolutions };
    for (const k of upgraded.reviewKeys) delete out[k];
    return out;
  }, [upgraded.doc.resolutions, upgraded.reviewKeys]);

  const merge = useMemo(
    () =>
      buildMergedDocument(base, brand, legal, effectiveResolutions, {
        reviewKeys: upgraded.reviewKeys,
      }),
    [base, brand, legal, effectiveResolutions, upgraded.reviewKeys],
  );

  /** 执行一次交接状态变更；失败时记录 actionError 供界面提示。 */
  const act = useCallback(
    (label: string, fn: (doc: WorkbenchDoc, who: ReviewerId, at: number) => WorkbenchDoc): boolean => {
      try {
        const next = fn(presentRef.current, identityRef.current, Date.now());
        if (next === presentRef.current) return true;
        setHistory((h) => pushHistory(h, h.present === next ? h.present : next));
        setActionError(null);
        return true;
      } catch (e) {
        if (e instanceof HandoffError) {
          setActionError({ code: e.code, message: e.message });
        } else {
          setActionError({ code: 'unknown', message: `${label}失败` });
        }
        return false;
      }
    },
    [],
  );

  const resolve = useCallback(
    (key: string, choice: Choice, manualText?: string) =>
      act('提交裁决', (doc, who, at) =>
        applyResolution(doc, {
          key,
          fingerprint: fingerprintOf(key),
          resolution: choice === 'manual' ? { choice, manualText: manualText ?? '' } : { choice },
          who,
          now: at,
        }),
      ),
    [act, fingerprintOf],
  );

  const unresolve = useCallback(
    (key: string) => act('重新打开', (doc, who, at) => unresolveConflict(doc, key, who, at)),
    [act],
  );

  const assign = useCallback(
    (key: string, to: ReviewerId) =>
      act('指派', (doc, who, at) => assignConflict(doc, key, fingerprintOf(key), who, to, at)),
    [act, fingerprintOf],
  );

  const claim = useCallback(
    (key: string) =>
      act('领取', (doc, _who, at) => claimConflict(doc, key, fingerprintOf(key), identityRef.current, at)),
    [act, fingerprintOf],
  );

  const handBack = useCallback(
    (key: string) => act('退回', (doc, who, at) => returnConflict(doc, key, who, at)),
    [act],
  );

  const forward = useCallback(
    (key: string, to: ReviewerId) =>
      act('转交', (doc, who, at) => forwardConflict(doc, key, fingerprintOf(key), who, to, at)),
    [act, fingerprintOf],
  );

  const confirmAsIs = useCallback(
    (key: string) =>
      act('确认复核', (doc, who, at) => confirmReview(doc, key, fingerprintOf(key), who, at)),
    [act, fingerprintOf],
  );

  const undo = useCallback(() => setHistory((h) => histUndo(h) ?? h), []);
  const redo = useCallback(() => setHistory((h) => histRedo(h) ?? h), []);

  const resetSample = useCallback(() => {
    setBaseText(SAMPLE_BASE);
    setBrandText(SAMPLE_BRAND);
    setLegalText(SAMPLE_LEGAL);
    setHistory((h) => {
      const empty = emptyDoc();
      const same =
        Object.keys(h.present.resolutions).length === 0 &&
        Object.keys(h.present.handoffs).length === 0;
      return same ? h : pushHistory(h, empty);
    });
    setActionError(null);
  }, []);

  const setIdentity = useCallback((id: ReviewerId) => {
    const trimmed = id.trim();
    if (trimmed) setIdentityState(trimmed);
  }, []);

  const lockOf = useCallback(
    (key: string) => getLock(upgraded.doc, key, now),
    [upgraded.doc, now],
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
    identity,
    setIdentity,
    now,
    doc: upgraded.doc,
    resolutions: upgraded.doc.resolutions,
    handoffs: upgraded.doc.handoffs,
    reviewKeys: upgraded.reviewKeys,
    expiredKeys: upgraded.expiredKeys,
    lockOf,
    resolve,
    unresolve,
    assign,
    claim,
    handBack,
    forward,
    confirmAsIs,
    undo,
    redo,
    canUndo: histCanUndo(history),
    canRedo: histCanRedo(history),
    resetSample,
    actionError,
    clearActionError: () => setActionError(null),
  };
}
