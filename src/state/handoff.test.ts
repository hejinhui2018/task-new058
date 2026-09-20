import { describe, it, expect } from 'vitest';
import type { Conflict } from '../lib/merge';
import {
  acknowledgeHandoff,
  claimHandoff,
  conflictFingerprint,
  handoffStatus,
  isHandoffLocked,
  reassignHandoff,
  remainingLabel,
  returnHandoff,
  type Handoffs,
} from './handoff';

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

describe('审校交接（纯函数）', () => {
  it('领取后处于审校中并锁定对应冲突', () => {
    const c = makeConflict();
    const handoffs = claimHandoff({}, c, '小王', T0, HOUR);
    const h = handoffs[c.id];
    expect(h.reviewer).toBe('小王');
    expect(h.createdAt).toBe(T0);
    expect(h.deadline).toBe(T0 + HOUR);
    expect(h.fingerprint).toBe(conflictFingerprint(c));
    const status = handoffStatus(h, c, T0 + 1000);
    expect(status).toBe('active');
    expect(isHandoffLocked(status)).toBe(true);
  });

  it('未超时时重复领取原样返回（重复提交不产生变化）', () => {
    const c = makeConflict();
    const first = claimHandoff({}, c, '小王', T0, HOUR);
    const second = claimHandoff(first, c, '小李', T0 + 1000, HOUR);
    expect(second).toBe(first);
    expect(second[c.id].reviewer).toBe('小王');
  });

  it('超时后解除锁定，且可重新领取', () => {
    const c = makeConflict();
    let handoffs = claimHandoff({}, c, '小王', T0, HOUR);
    const status = handoffStatus(handoffs[c.id], c, T0 + HOUR);
    expect(status).toBe('expired');
    expect(isHandoffLocked(status)).toBe(false);
    // 超时记录可被新的领取覆盖
    handoffs = claimHandoff(handoffs, c, '小李', T0 + HOUR, HOUR);
    expect(handoffs[c.id].reviewer).toBe('小李');
    expect(handoffs[c.id].deadline).toBe(T0 + 2 * HOUR);
    expect(handoffStatus(handoffs[c.id], c, T0 + HOUR + 1)).toBe('active');
  });

  it('退回解除交接；对不存在的记录退回是空操作', () => {
    const c = makeConflict();
    const handoffs = claimHandoff({}, c, '小王', T0, HOUR);
    const returned = returnHandoff(handoffs, c.id);
    expect(returned[c.id]).toBeUndefined();
    expect(returnHandoff(handoffs, 'c99')).toBe(handoffs);
  });

  it('转交更换审校人、重计时限并保留领取时间；无记录时是空操作', () => {
    const c = makeConflict();
    const handoffs = claimHandoff({}, c, '小王', T0, HOUR);
    const moved = reassignHandoff(handoffs, c, '小李', T0 + 1000, 2 * HOUR);
    expect(moved[c.id].reviewer).toBe('小李');
    expect(moved[c.id].createdAt).toBe(T0);
    expect(moved[c.id].deadline).toBe(T0 + 1000 + 2 * HOUR);
    expect(reassignHandoff(handoffs, makeConflict({ id: 'c99' }), '小李', T0, HOUR)).toBe(handoffs);
  });

  it('来源文稿变化后交接变为待复核（仍锁定），确认复核后恢复审校中', () => {
    const c = makeConflict();
    const handoffs = claimHandoff({}, c, '小王', T0, HOUR);
    const changed = makeConflict({ brandText: '二品牌再改' });
    const staleStatus = handoffStatus(handoffs[c.id], changed, T0 + 1000);
    expect(staleStatus).toBe('stale');
    expect(isHandoffLocked(staleStatus)).toBe(true);
    // 确认复核：指纹更新为当前内容
    const acked = acknowledgeHandoff(handoffs, changed);
    expect(handoffStatus(acked[c.id], changed, T0 + 1000)).toBe('active');
    // 指纹已一致时确认是空操作
    expect(acknowledgeHandoff(acked, changed)).toBe(acked);
  });

  it('移动锚点变化同样触发待复核', () => {
    const c = makeConflict({ type: 'move-move', brandAnchor: 3, legalAnchor: 5 });
    const handoffs = claimHandoff({}, c, '小王', T0, HOUR);
    const moved = makeConflict({ type: 'move-move', brandAnchor: 2, legalAnchor: 5 });
    expect(handoffStatus(handoffs[c.id], moved, T0 + 1000)).toBe('stale');
  });

  it('冲突消失时交接不再锁定（orphaned）', () => {
    const c = makeConflict();
    const handoffs = claimHandoff({}, c, '小王', T0, HOUR);
    const status = handoffStatus(handoffs[c.id], undefined, T0 + 1000);
    expect(status).toBe('orphaned');
    expect(isHandoffLocked(status)).toBe(false);
  });

  it('多冲突并行交接互不影响', () => {
    const c1 = makeConflict({ id: 'c1' });
    const c6 = makeConflict({ id: 'c6', baseIdx: 6 });
    let handoffs: Handoffs = {};
    handoffs = claimHandoff(handoffs, c1, '小王', T0, HOUR);
    handoffs = claimHandoff(handoffs, c6, '小李', T0, HOUR);
    expect(Object.keys(handoffs)).toHaveLength(2);
    // 退回 c1 不影响 c6
    handoffs = returnHandoff(handoffs, 'c1');
    expect(handoffs['c1']).toBeUndefined();
    expect(handoffStatus(handoffs['c6'], c6, T0 + 1000)).toBe('active');
    // 转交 c6 不影响其他记录
    handoffs = reassignHandoff(handoffs, c6, '小赵', T0, HOUR);
    expect(handoffs['c6'].reviewer).toBe('小赵');
  });

  it('剩余时限的人话描述', () => {
    const c = makeConflict();
    const handoffs = claimHandoff({}, c, '小王', T0, HOUR);
    const h = handoffs[c.id];
    expect(remainingLabel(h, T0)).toBe('剩余约 1 小时');
    expect(remainingLabel(h, T0 + HOUR - 60_000)).toBe('剩余 1 分钟');
    expect(remainingLabel(h, T0 + HOUR)).toBe('已超时');
  });
});
