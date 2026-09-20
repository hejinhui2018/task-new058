import type { Conflict } from '../lib/merge';

/**
 * 审校交接：把某处冲突的"待确认"状态按冲突身份交给指定审校人。
 *
 * - 交接记录以冲突 id 为键持久化（localStorage），刷新后局部锁定不丢失；
 * - 记录保存交接时的冲突内容指纹，来源文稿变化后受影响的交接变为"待复核"，
 *   未受影响的交接与裁决原样保留；
 * - 交接只锁定对应冲突：审校中 / 待复核期间该冲突不可直接裁决，
 *   超时后自动解除锁定（记录保留，可退回或重新指派）。
 */

export interface Handoff {
  conflictId: string;
  /** 审校人姓名 */
  reviewer: string;
  /** 领取时间戳 */
  createdAt: number;
  /** 超时时间戳（now >= deadline 视为已超时） */
  deadline: number;
  /** 交接时的冲突内容指纹；与当前指纹不一致 → 待复核 */
  fingerprint: string;
}

/** 冲突 id -> 交接记录 */
export type Handoffs = Record<string, Handoff>;

/**
 * 交接状态：
 * - active：审校中（锁定）
 * - stale：待复核——来源文稿变化导致冲突内容与交接时不一致（仍锁定，需复核确认）
 * - expired：已超时（解除锁定，记录保留）
 * - orphaned：对应冲突已不存在（不再锁定，记录随冲突消失而失去作用）
 */
export type HandoffStatus = 'active' | 'stale' | 'expired' | 'orphaned';

/** 交接时限选项（领取 / 转交时选择） */
export const HANDOFF_TTL_OPTIONS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '1 小时', ms: 3_600_000 },
  { label: '4 小时', ms: 14_400_000 },
  { label: '1 天', ms: 86_400_000 },
  { label: '3 天', ms: 259_200_000 },
];

export const DEFAULT_TTL_MS = 86_400_000;

/** 冲突内容指纹：类型 + 三方文本 + 移动锚点。任一项变化都视为"同一冲突的新内容"。 */
export function conflictFingerprint(c: Conflict): string {
  return JSON.stringify([c.type, c.baseText, c.brandText, c.legalText, c.brandAnchor, c.legalAnchor]);
}

/** 推导交接当前状态。内容变化优先于超时判定：先复核内容，再谈时限。 */
export function handoffStatus(handoff: Handoff, conflict: Conflict | undefined, now: number): HandoffStatus {
  if (!conflict) return 'orphaned';
  if (handoff.fingerprint !== conflictFingerprint(conflict)) return 'stale';
  if (now >= handoff.deadline) return 'expired';
  return 'active';
}

/** 该交接是否锁定对应冲突（锁定期间不可直接裁决） */
export function isHandoffLocked(status: HandoffStatus): boolean {
  return status === 'active' || status === 'stale';
}

/**
 * 领取 / 指派：把冲突交给审校人。
 * 已存在未超时记录时原样返回（重复提交不产生变化）；已超时的记录可被重新指派覆盖。
 */
export function claimHandoff(
  handoffs: Handoffs,
  conflict: Conflict,
  reviewer: string,
  now: number,
  ttlMs: number,
): Handoffs {
  const existing = handoffs[conflict.id];
  if (existing && now < existing.deadline) return handoffs;
  return {
    ...handoffs,
    [conflict.id]: {
      conflictId: conflict.id,
      reviewer,
      createdAt: now,
      deadline: now + ttlMs,
      fingerprint: conflictFingerprint(conflict),
    },
  };
}

/** 退回：解除交接，冲突回到可直接裁决状态。无记录时原样返回。 */
export function returnHandoff(handoffs: Handoffs, conflictId: string): Handoffs {
  if (!(conflictId in handoffs)) return handoffs;
  const next = { ...handoffs };
  delete next[conflictId];
  return next;
}

/**
 * 转交：更换审校人并重计时限；指纹重置为当前冲突内容（新审校人面对当前版本）。
 * 保留原领取时间。无记录时原样返回。
 */
export function reassignHandoff(
  handoffs: Handoffs,
  conflict: Conflict,
  reviewer: string,
  now: number,
  ttlMs: number,
): Handoffs {
  const existing = handoffs[conflict.id];
  if (!existing) return handoffs;
  return {
    ...handoffs,
    [conflict.id]: {
      ...existing,
      reviewer,
      deadline: now + ttlMs,
      fingerprint: conflictFingerprint(conflict),
    },
  };
}

/** 复核确认：来源变化后确认以当前内容为准继续审校（清除"待复核"）。无记录或指纹已一致时原样返回。 */
export function acknowledgeHandoff(handoffs: Handoffs, conflict: Conflict): Handoffs {
  const existing = handoffs[conflict.id];
  if (!existing) return handoffs;
  const fingerprint = conflictFingerprint(conflict);
  if (existing.fingerprint === fingerprint) return handoffs;
  return { ...handoffs, [conflict.id]: { ...existing, fingerprint } };
}

/** 剩余时限的人话描述（界面用） */
export function remainingLabel(handoff: Handoff, now: number): string {
  const ms = handoff.deadline - now;
  if (ms <= 0) return '已超时';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `剩余约 ${hours} 小时`;
  return `剩余约 ${Math.floor(hours / 24)} 天`;
}
