/**
 * 审校交接：按"冲突稳定身份（conflict key）"保存的交接状态机。
 *
 * 纯函数、不可变更新，便于单元测试与撤销/重做（整个 WorkbenchDoc 进历史栈）。
 * 交接生命周期：
 *   指派 assign ──▶ assigned ──领取 claim──▶ claimed
 *                     │                        ├── 退回 return ──▶ returned（任何人可再领取）
 *                     │                        ├── 转交 forward ──▶ claimed（新审校人，锁不松）
 *                     │                        └── 超时 expire ──▶ timeout（锁释放，可再领取）
 *                     └── 提交裁决 applyResolution ──▶ done
 *   来源文稿变化且影响到该冲突 ──▶ review：裁决/交接保留但暂不生效，需复核确认。
 */
import type { Conflict, Resolution, Resolutions } from './merge';

export type ReviewerId = string;

export type HandoffStatus =
  | 'assigned'
  | 'claimed'
  | 'returned'
  | 'timeout'
  | 'review'
  | 'done';

export interface Handoff {
  conflictKey: string;
  status: HandoffStatus;
  /** 当前审校人；退回/超时后为 null（锁释放） */
  owner: ReviewerId | null;
  assignedBy: ReviewerId | null;
  lastActor: ReviewerId | null;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  /** claimed 状态的处理截止时间；到达即超时 */
  deadline: number | null;
  /** 进入 review 前的状态，复核通过后据此恢复 */
  prevStatus: HandoffStatus | null;
}

export type Handoffs = Record<string, Handoff>;

/** 持久化文档：裁决与交接都按冲突 key 保存，fingerprint 记录保存时的冲突内容。 */
export interface WorkbenchDoc {
  resolutions: Resolutions;
  handoffs: Handoffs;
  fingerprints: Record<string, string>;
}

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class HandoffError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
  }
}

export function emptyDoc(): WorkbenchDoc {
  return { resolutions: {}, handoffs: {}, fingerprints: {} };
}

function clone(doc: WorkbenchDoc): WorkbenchDoc {
  return {
    resolutions: { ...doc.resolutions },
    handoffs: { ...doc.handoffs },
    fingerprints: { ...doc.fingerprints },
  };
}

function sameResolution(a: Resolution | undefined, b: Resolution | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.choice === b.choice && (a.manualText ?? '') === (b.manualText ?? '');
}

function isActive(h: Handoff | undefined, now: number): boolean {
  if (!h) return false;
  if (h.status === 'assigned') return true;
  if (h.status === 'claimed') return h.deadline === null || h.deadline > now;
  return false;
}

/** 冲突当前是否被他人锁定（已决定的冲突不再锁定任何人）。 */
export function getLock(
  doc: WorkbenchDoc,
  key: string,
  now: number,
): { locked: boolean; owner: ReviewerId | null } {
  if (doc.resolutions[key]) return { locked: false, owner: null };
  const h = doc.handoffs[key];
  if (isActive(h, now) && h.owner) return { locked: true, owner: h.owner };
  return { locked: false, owner: null };
}

/** 指派给指定审校人；存在有效锁定时不能改派（请走转交）。 */
export function assignConflict(
  doc: WorkbenchDoc,
  key: string,
  fingerprint: string,
  by: ReviewerId,
  to: ReviewerId,
  now: number,
): WorkbenchDoc {
  const reviewer = to.trim();
  if (!reviewer) throw new HandoffError('bad-reviewer', '请指定审校人');
  const existing = doc.handoffs[key];
  if (isActive(existing, now) && existing.owner && existing.owner !== reviewer) {
    throw new HandoffError('locked', `该冲突已由 ${existing.owner} 处理中，不能直接指派`);
  }
  if (existing && existing.status === 'assigned' && existing.owner === reviewer) return doc;

  const next = clone(doc);
  const prev = doc.handoffs[key];
  next.handoffs[key] = {
    conflictKey: key,
    status: 'assigned',
    owner: reviewer,
    assignedBy: prev?.assignedBy ?? by,
    lastActor: by,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    claimedAt: null,
    deadline: null,
    prevStatus: null,
  };
  next.fingerprints[key] = fingerprint;
  return next;
}

/** 领取：指派给自己时确认领取；也支持从退回/超时池中认领。 */
export function claimConflict(
  doc: WorkbenchDoc,
  key: string,
  fingerprint: string,
  who: ReviewerId,
  now: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): WorkbenchDoc {
  const h = doc.handoffs[key];
  if (isActive(h, now) && h.owner && h.owner !== who) {
    throw new HandoffError('locked', `该冲突已指派给 ${h.owner}`);
  }
  const canClaim =
    !h ||
    h.status === 'returned' ||
    h.status === 'timeout' ||
    (h.status === 'claimed' && (!isActive(h, now) || h.owner === who)) ||
    (h.status === 'assigned' && (h.owner === who || h.owner === null));
  if (!canClaim) {
    throw new HandoffError('not-claimable', '当前交接状态不能领取');
  }
  const next = clone(doc);
  next.handoffs[key] = {
    conflictKey: key,
    status: 'claimed',
    owner: who,
    assignedBy: h?.assignedBy ?? who,
    lastActor: who,
    createdAt: h?.createdAt ?? now,
    updatedAt: now,
    claimedAt: now,
    deadline: now + timeoutMs,
    prevStatus: null,
  };
  next.fingerprints[key] = fingerprint;
  return next;
}

/** 退回：领取人放弃处理，锁立即释放，其他人可领取。 */
export function returnConflict(doc: WorkbenchDoc, key: string, who: ReviewerId, now: number): WorkbenchDoc {
  const h = doc.handoffs[key];
  if (!h || !isActive(h, now) || h.owner !== who) {
    throw new HandoffError('not-owner', '只有当前处理人可以退回');
  }
  const next = clone(doc);
  next.handoffs[key] = {
    ...h,
    status: 'returned',
    owner: null,
    lastActor: who,
    updatedAt: now,
    deadline: null,
  };
  return next;
}

/** 转交给另一位审校人：锁连续转移、截止时间重新计算，其他人仍然不能提交。 */
export function forwardConflict(
  doc: WorkbenchDoc,
  key: string,
  fingerprint: string,
  who: ReviewerId,
  to: ReviewerId,
  now: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): WorkbenchDoc {
  const reviewer = to.trim();
  if (!reviewer) throw new HandoffError('bad-reviewer', '请指定转交对象');
  if (reviewer === who) throw new HandoffError('bad-reviewer', '不能转交给自己');
  const h = doc.handoffs[key];
  if (!h || !isActive(h, now) || h.owner !== who) {
    throw new HandoffError('not-owner', '只有当前处理人可以转交');
  }
  const next = clone(doc);
  next.handoffs[key] = {
    conflictKey: key,
    status: 'claimed',
    owner: reviewer,
    assignedBy: h.assignedBy,
    lastActor: who,
    createdAt: h.createdAt,
    updatedAt: now,
    claimedAt: now,
    deadline: now + timeoutMs,
    prevStatus: null,
  };
  next.fingerprints[key] = fingerprint;
  return next;
}

/** 扫描所有已过截止时间的领取记录并释放锁。 */
export function expireLocks(doc: WorkbenchDoc, now: number): { doc: WorkbenchDoc; expired: string[] } {
  const expired: string[] = [];
  let changed = false;
  const handoffs: Handoffs = {};
  for (const [key, h] of Object.entries(doc.handoffs)) {
    if (h.status === 'claimed' && h.deadline !== null && h.deadline <= now) {
      expired.push(key);
      changed = true;
      handoffs[key] = {
        ...h,
        status: 'timeout',
        owner: null,
        updatedAt: now,
        deadline: null,
      };
    } else {
      handoffs[key] = h;
    }
  }
  if (!changed) return { doc, expired };
  return { doc: { ...doc, handoffs }, expired };
}

export interface SubmitInput {
  key: string;
  fingerprint: string;
  resolution: Resolution;
  who: ReviewerId;
  now: number;
}

/**
 * 提交裁决。守卫：
 * - 交接进行中（assigned/claimed 未超时）时只有当前审校人能提交；
 * - 完全相同的裁决重复提交会被拒绝（防重复提交）；
 * - 提交即完成交接（done）并释放锁；
 * - 用于来源已变化（review）的冲突时，顺手刷新指纹，退出待复核。
 */
export function applyResolution(doc: WorkbenchDoc, input: SubmitInput): WorkbenchDoc {
  const { key, fingerprint, resolution, who, now } = input;
  const h = doc.handoffs[key];
  if (isActive(h, now) && h.owner && h.owner !== who) {
    throw new HandoffError('locked', `该冲突正由 ${h.owner} 处理，你不能提交`);
  }
  const existing = doc.resolutions[key];
  const underReview = doc.fingerprints[key] !== undefined && doc.fingerprints[key] !== fingerprint;
  if (existing && sameResolution(existing, resolution) && !underReview) {
    throw new HandoffError('duplicate', '该裁决已经提交，请勿重复提交');
  }
  const next = clone(doc);
  next.resolutions[key] = resolution;
  next.fingerprints[key] = fingerprint;
  // 始终留一条完成记录作为裁决审计（谁、何时提交）
  next.handoffs[key] = {
    conflictKey: key,
    status: 'done',
    owner: h?.owner ?? who,
    assignedBy: h?.assignedBy ?? null,
    lastActor: who,
    createdAt: h?.createdAt ?? now,
    updatedAt: now,
    claimedAt: h?.claimedAt ?? null,
    deadline: null,
    prevStatus: null,
  };
  return next;
}

/** 重新打开：删除裁决，交接记录退回公共池（锁释放）。 */
export function unresolveConflict(doc: WorkbenchDoc, key: string, who: ReviewerId, now: number): WorkbenchDoc {
  if (!doc.resolutions[key]) return doc;
  const h = doc.handoffs[key];
  if (isActive(h, now) && h.owner && h.owner !== who) {
    throw new HandoffError('locked', `该冲突正由 ${h.owner} 处理，你不能重新打开`);
  }
  const next = clone(doc);
  delete next.resolutions[key];
  if (h) {
    next.handoffs[key] = {
      ...h,
      status: 'returned',
      owner: null,
      lastActor: who,
      updatedAt: now,
      deadline: null,
      prevStatus: null,
    };
  }
  return next;
}

/**
 * 计算当前冲突中"来源已变化、需要复核"的 key 集合：
 * 保存过指纹且指纹不一致，并且存在已保存裁决或进行中交接。
 */
export function computeReviewKeys(doc: WorkbenchDoc, conflicts: Conflict[]): Set<string> {
  const reviewKeys = new Set<string>();
  for (const c of conflicts) {
    const savedFp = doc.fingerprints[c.key];
    if (savedFp === undefined || savedFp === c.fingerprint) continue;
    const h = doc.handoffs[c.key];
    const activeHandoff = h && (h.status === 'assigned' || h.status === 'claimed' || h.status === 'review');
    if (doc.resolutions[c.key] || activeHandoff) reviewKeys.add(c.key);
  }
  return reviewKeys;
}

/**
 * 来源文稿变化后的对账：
 * - 指纹一致 → 裁决与交接原样保留；
 * - 指纹变化且存在已保存裁决或进行中交接 → 进入 review（裁决保留备查，锁挂起）；
 * - 冲突已消失 → 记录原样保留（惰性），不影响当前合并；若同内容冲突再次出现可自动接回。
 * 返回新文档与需要在合并引擎中屏蔽旧裁决的 reviewKey 集合。
 */
export function reconcileDoc(
  doc: WorkbenchDoc,
  conflicts: Conflict[],
  now: number,
): { doc: WorkbenchDoc; reviewKeys: Set<string> } {
  const reviewKeys = computeReviewKeys(doc, conflicts);
  let changed = false;
  const handoffs = { ...doc.handoffs };

  for (const key of reviewKeys) {
    const h = doc.handoffs[key];
    if (h && h.status !== 'review') {
      handoffs[key] = {
        ...h,
        status: 'review',
        prevStatus: h.status === 'assigned' || h.status === 'claimed' ? h.status : null,
        deadline: null,
        updatedAt: now,
      };
      changed = true;
    } else if (!h) {
      // 只有裁决、没有交接记录：补一条 review 记录用于界面提示
      handoffs[key] = {
        conflictKey: key,
        status: 'review',
        owner: null,
        assignedBy: null,
        lastActor: null,
        createdAt: now,
        updatedAt: now,
        claimedAt: null,
        deadline: null,
        prevStatus: null,
      };
      changed = true;
    }
  }

  return {
    doc: changed ? { ...doc, handoffs } : doc,
    reviewKeys,
  };
}

/**
 * 复核通过：
 * - 沿用原裁决 → 指纹更新、交接记为 done；
 * - 无裁决（原交接进行中）→ 按进入复核前的状态恢复（claimed 重新计时）。
 * 也可以不调用本函数、直接用 applyResolution 提交一份新裁决，效果同样退出复核。
 */
export function confirmReview(
  doc: WorkbenchDoc,
  key: string,
  fingerprint: string,
  who: ReviewerId,
  now: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): WorkbenchDoc {
  const h = doc.handoffs[key];
  const wasUnderReview = doc.fingerprints[key] !== undefined && doc.fingerprints[key] !== fingerprint;
  if (!wasUnderReview && (!h || h.status !== 'review')) {
    throw new HandoffError('not-review', '该冲突不在待复核状态');
  }
  const next = clone(doc);
  next.fingerprints[key] = fingerprint;
  if (doc.resolutions[key]) {
    next.handoffs[key] = {
      conflictKey: key,
      status: 'done',
      owner: who,
      assignedBy: h?.assignedBy ?? null,
      lastActor: who,
      createdAt: h?.createdAt ?? now,
      updatedAt: now,
      claimedAt: null,
      deadline: null,
      prevStatus: null,
    };
  } else {
    const restore = h?.prevStatus === 'assigned' ? 'assigned' : 'claimed';
    next.handoffs[key] = {
      conflictKey: key,
      status: restore,
      owner: h?.owner ?? who,
      assignedBy: h?.assignedBy ?? who,
      lastActor: who,
      createdAt: h?.createdAt ?? now,
      updatedAt: now,
      claimedAt: restore === 'claimed' ? now : null,
      deadline: restore === 'claimed' ? now + timeoutMs : null,
      prevStatus: null,
    };
  }
  return next;
}

/** 把旧版本（按下标 id 保存）的裁决迁移到稳定 key。 */
export function migrateLegacyResolutions(
  byId: Resolutions,
  conflicts: Conflict[],
): WorkbenchDoc {
  const doc = emptyDoc();
  for (const c of conflicts) {
    const r = byId[c.id];
    if (r) {
      doc.resolutions[c.key] = r;
      doc.fingerprints[c.key] = c.fingerprint;
      doc.handoffs[c.key] = {
        conflictKey: c.key,
        status: 'done',
        owner: null,
        assignedBy: null,
        lastActor: null,
        createdAt: 0,
        updatedAt: 0,
        claimedAt: null,
        deadline: null,
        prevStatus: null,
      };
    }
  }
  return doc;
}

/** 派生：某个冲突是否处于待复核。 */
export function isUnderReview(doc: WorkbenchDoc, conflict: Conflict): boolean {
  return doc.fingerprints[conflict.key] !== undefined
    && doc.fingerprints[conflict.key] !== conflict.fingerprint;
}
