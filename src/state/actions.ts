import type { Conflict, Resolution, Resolutions } from '../lib/merge';
import {
  acknowledgeHandoff,
  claimHandoff,
  reassignHandoff,
  returnHandoff,
  type Handoffs,
} from './handoff';

/**
 * 工作台可撤销状态：冲突裁决 + 审校交接。
 * 所有操作都是纯函数；无实际变化时原样返回（Object.is 不变），
 * 因此重复提交（双击、重放）不会产生新的历史记录。
 */
export interface WorkbenchState {
  resolutions: Resolutions;
  handoffs: Handoffs;
}

export const EMPTY_WORKBENCH_STATE: WorkbenchState = { resolutions: {}, handoffs: {} };

function sameResolution(a: Resolution | undefined, b: Resolution): boolean {
  return a !== undefined && a.choice === b.choice && (a.manualText ?? '') === (b.manualText ?? '');
}

/**
 * 应用裁决。裁决落定即视为审校完成：该冲突的交接记录一并解除。
 * 重复提交相同裁决（且本无交接需要解除）时原样返回。
 */
export function applyResolution(state: WorkbenchState, id: string, resolution: Resolution): WorkbenchState {
  const hasHandoff = id in state.handoffs;
  if (sameResolution(state.resolutions[id], resolution) && !hasHandoff) return state;
  const resolutions = { ...state.resolutions, [id]: resolution };
  const handoffs = hasHandoff ? returnHandoff(state.handoffs, id) : state.handoffs;
  return { resolutions, handoffs };
}

/** 重新打开：移除某冲突的裁决。无裁决时原样返回。 */
export function removeResolution(state: WorkbenchState, id: string): WorkbenchState {
  if (!(id in state.resolutions)) return state;
  const resolutions = { ...state.resolutions };
  delete resolutions[id];
  return { ...state, resolutions };
}

/** 领取 / 指派审校。已有未超时交接时原样返回（重复领取无效）。 */
export function applyClaim(
  state: WorkbenchState,
  conflict: Conflict,
  reviewer: string,
  now: number,
  ttlMs: number,
): WorkbenchState {
  const handoffs = claimHandoff(state.handoffs, conflict, reviewer, now, ttlMs);
  return handoffs === state.handoffs ? state : { ...state, handoffs };
}

/** 退回交接。无记录时原样返回。 */
export function applyReturn(state: WorkbenchState, conflictId: string): WorkbenchState {
  const handoffs = returnHandoff(state.handoffs, conflictId);
  return handoffs === state.handoffs ? state : { ...state, handoffs };
}

/** 转交：更换审校人并重计时限。无记录时原样返回。 */
export function applyReassign(
  state: WorkbenchState,
  conflict: Conflict,
  reviewer: string,
  now: number,
  ttlMs: number,
): WorkbenchState {
  const handoffs = reassignHandoff(state.handoffs, conflict, reviewer, now, ttlMs);
  return handoffs === state.handoffs ? state : { ...state, handoffs };
}

/** 复核确认：以当前冲突内容为准继续审校。无需复核时原样返回。 */
export function applyAcknowledge(state: WorkbenchState, conflict: Conflict): WorkbenchState {
  const handoffs = acknowledgeHandoff(state.handoffs, conflict);
  return handoffs === state.handoffs ? state : { ...state, handoffs };
}
