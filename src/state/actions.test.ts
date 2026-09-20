import { describe, it, expect } from 'vitest';
import type { Conflict } from '../lib/merge';
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

const T0 = 1_000_000;
const HOUR = 3_600_000;

function makeConflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    id: 'c1',
    type: 'edit-edit',
    baseIdx: 1,
    baseText: '二',
    brandText: '二品牌',
    legalText: '二法务',
    brandAnchor: null,
    legalAnchor: null,
    ...overrides,
  };
}

describe('工作台状态操作（裁决 + 交接）', () => {
  it('应用裁决写入记录；重复提交相同裁决原样返回', () => {
    const s1 = applyResolution(EMPTY_WORKBENCH_STATE, 'c1', { choice: 'legal' });
    expect(s1.resolutions['c1']).toEqual({ choice: 'legal' });
    const s2 = applyResolution(s1, 'c1', { choice: 'legal' });
    expect(s2).toBe(s1);
    // 不同裁决则产生新状态
    const s3 = applyResolution(s1, 'c1', { choice: 'brand' });
    expect(s3).not.toBe(s1);
    expect(s3.resolutions['c1'].choice).toBe('brand');
  });

  it('裁决落定即解除该冲突的交接', () => {
    const c = makeConflict();
    let s: WorkbenchState = applyClaim(EMPTY_WORKBENCH_STATE, c, '小王', T0, HOUR);
    expect(s.handoffs['c1']).toBeDefined();
    s = applyResolution(s, 'c1', { choice: 'legal' });
    expect(s.handoffs['c1']).toBeUndefined();
    expect(s.resolutions['c1']).toEqual({ choice: 'legal' });
  });

  it('重新打开移除裁决；无裁决时是空操作', () => {
    const s1 = applyResolution(EMPTY_WORKBENCH_STATE, 'c1', { choice: 'base' });
    const s2 = removeResolution(s1, 'c1');
    expect(s2.resolutions['c1']).toBeUndefined();
    expect(removeResolution(s1, 'c99')).toBe(s1);
  });

  it('领取写入交接；重复领取原样返回', () => {
    const c = makeConflict();
    const s1 = applyClaim(EMPTY_WORKBENCH_STATE, c, '小王', T0, HOUR);
    expect(s1.handoffs['c1'].reviewer).toBe('小王');
    expect(applyClaim(s1, c, '小李', T0 + 1, HOUR)).toBe(s1);
  });

  it('退回 / 转交 / 复核确认都作用于交接记录', () => {
    const c = makeConflict();
    let s = applyClaim(EMPTY_WORKBENCH_STATE, c, '小王', T0, HOUR);
    // 转交
    s = applyReassign(s, c, '小李', T0 + 1, HOUR);
    expect(s.handoffs['c1'].reviewer).toBe('小李');
    // 复核确认（内容未变 → 空操作）
    expect(applyAcknowledge(s, c)).toBe(s);
    // 内容变化后确认复核
    const changed = makeConflict({ legalText: '二法务再改' });
    const acked = applyAcknowledge(s, changed);
    expect(acked).not.toBe(s);
    expect(acked.handoffs['c1'].fingerprint).not.toBe(s.handoffs['c1'].fingerprint);
    // 退回
    const returned = applyReturn(acked, 'c1');
    expect(returned.handoffs['c1']).toBeUndefined();
    expect(applyReturn(returned, 'c1')).toBe(returned);
  });

  it('交接与裁决互不影响：锁定一个冲突不影响裁决另一个', () => {
    const c1 = makeConflict({ id: 'c1' });
    const c6 = makeConflict({ id: 'c6', baseIdx: 6 });
    let s = applyClaim(EMPTY_WORKBENCH_STATE, c1, '小王', T0, HOUR);
    s = applyResolution(s, 'c6', { choice: 'brand' });
    expect(s.handoffs['c1']).toBeDefined();
    expect(s.resolutions['c6']).toEqual({ choice: 'brand' });
    // 裁决 c6 不会误清 c1 的交接
    s = applyClaim(s, c6, '小李', T0, HOUR);
    expect(Object.keys(s.handoffs).sort()).toEqual(['c1', 'c6']);
  });
});
