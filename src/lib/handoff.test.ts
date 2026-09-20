import { describe, it, expect } from 'vitest';
import { buildMergedDocument, exportMergedText } from './merge';
import { remapDocAfterBaseEdit } from './identity';
import {
  applyResolution,
  assignConflict,
  claimConflict,
  computeReviewKeys,
  confirmReview,
  emptyDoc,
  expireLocks,
  forwardConflict,
  getLock,
  HandoffError,
  migrateLegacyResolutions,
  reconcileDoc,
  returnConflict,
  unresolveConflict,
} from './handoff';

/** 单冲突夹具：底稿"二"被双方分别改写。 */
function fixture() {
  const base = ['一', '二', '三'];
  const brand = ['一', '二品牌', '三'];
  const legal = ['一', '二法务', '三'];
  const merge = buildMergedDocument(base, brand, legal, {});
  const c = merge.conflicts[0];
  return { base, brand, legal, c, merge };
}

/** 两个 edit-edit 冲突的夹具。 */
function twoConflictFixture() {
  const base = ['一', '二', '三', '四'];
  const brand = ['一', '二B', '三', '四B'];
  const legal = ['一', '二L', '三', '四L'];
  const merge = buildMergedDocument(base, brand, legal, {});
  expect(merge.conflicts).toHaveLength(2);
  return { base, brand, legal, c1: merge.conflicts[0], c2: merge.conflicts[1] };
}

function expectError(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error('应当抛出错误');
  } catch (e) {
    expect(e).toBeInstanceOf(HandoffError);
    expect((e as HandoffError).code).toBe(code);
  }
}

describe('审校交接状态机', () => {
  it('指派后只锁定该冲突，其他人不能提交', () => {
    const { c } = fixture();
    const t0 = 1_000_000;
    let doc = assignConflict(emptyDoc(), c.key, c.fingerprint, '编辑甲', '审校小林', t0);
    doc = claimConflict(doc, c.key, c.fingerprint, '审校小林', t0 + 1000);

    expect(getLock(doc, c.key, t0 + 2000)).toEqual({ locked: true, owner: '审校小林' });
    expectError(
      () =>
        applyResolution(doc, {
          key: c.key,
          fingerprint: c.fingerprint,
          resolution: { choice: 'legal' },
          who: '审校老周',
          now: t0 + 2000,
        }),
      'locked',
    );
    // 持有者本人可以提交
    const done = applyResolution(doc, {
      key: c.key,
      fingerprint: c.fingerprint,
      resolution: { choice: 'legal' },
      who: '审校小林',
      now: t0 + 2000,
    });
    expect(done.handoffs[c.key].status).toBe('done');
    expect(getLock(done, c.key, t0 + 3000).locked).toBe(false);
  });

  it('多冲突并行：锁定彼此独立，可继续处理其他冲突', () => {
    const { c1, c2 } = twoConflictFixture();
    const t0 = 2_000_000;
    let doc = assignConflict(emptyDoc(), c1.key, c1.fingerprint, '编辑甲', '审校小林', t0);
    doc = claimConflict(doc, c1.key, c1.fingerprint, '审校小林', t0);
    doc = assignConflict(doc, c2.key, c2.fingerprint, '编辑甲', '审校老周', t0);
    doc = claimConflict(doc, c2.key, c2.fingerprint, '审校老周', t0);

    expect(getLock(doc, c1.key, t0 + 1000).owner).toBe('审校小林');
    expect(getLock(doc, c2.key, t0 + 1000).owner).toBe('审校老周');

    // 小林不能动 c2，老周不能动 c1，但各自能提交自己的
    expectError(
      () =>
        applyResolution(doc, {
          key: c2.key,
          fingerprint: c2.fingerprint,
          resolution: { choice: 'brand' },
          who: '审校小林',
          now: t0 + 1000,
        }),
      'locked',
    );
    doc = applyResolution(doc, {
      key: c1.key,
      fingerprint: c1.fingerprint,
      resolution: { choice: 'legal' },
      who: '审校小林',
      now: t0 + 1000,
    });
    // c1 锁释放，c2 仍锁定
    expect(getLock(doc, c1.key, t0 + 2000).locked).toBe(false);
    expect(getLock(doc, c2.key, t0 + 2000).owner).toBe('审校老周');
  });

  it('退回后锁释放，其他人可以领取', () => {
    const { c } = fixture();
    const t0 = 3_000_000;
    let doc = assignConflict(emptyDoc(), c.key, c.fingerprint, '编辑甲', '审校小林', t0);
    doc = claimConflict(doc, c.key, c.fingerprint, '审校小林', t0);
    doc = returnConflict(doc, c.key, '审校小林', t0 + 500);
    expect(doc.handoffs[c.key].status).toBe('returned');
    expect(getLock(doc, c.key, t0 + 600).locked).toBe(false);

    doc = claimConflict(doc, c.key, c.fingerprint, '审校老周', t0 + 700);
    expect(doc.handoffs[c.key].owner).toBe('审校老周');
    expect(doc.handoffs[c.key].status).toBe('claimed');

    // 非持有者不能退回
    expectError(() => returnConflict(doc, c.key, '审校小林', t0 + 800), 'not-owner');
  });

  it('转交：锁连续转移到新审校人，原持有者失去提交权', () => {
    const { c } = fixture();
    const t0 = 4_000_000;
    let doc = claimConflict(emptyDoc(), c.key, c.fingerprint, '审校小林', t0);
    doc = forwardConflict(doc, c.key, c.fingerprint, '审校小林', '审校老周', t0 + 1000);

    expect(doc.handoffs[c.key].owner).toBe('审校老周');
    expect(doc.handoffs[c.key].status).toBe('claimed');
    expect(getLock(doc, c.key, t0 + 2000).owner).toBe('审校老周');
    expectError(
      () =>
        applyResolution(doc, {
          key: c.key,
          fingerprint: c.fingerprint,
          resolution: { choice: 'brand' },
          who: '审校小林',
          now: t0 + 2000,
        }),
      'locked',
    );
    // 不能转交给自己 / 空对象
    expectError(
      () => forwardConflict(doc, c.key, c.fingerprint, '审校老周', '审校老周', t0 + 2000),
      'bad-reviewer',
    );
    // 新持有者可以提交
    doc = applyResolution(doc, {
      key: c.key,
      fingerprint: c.fingerprint,
      resolution: { choice: 'brand' },
      who: '审校老周',
      now: t0 + 3000,
    });
    expect(doc.handoffs[c.key].status).toBe('done');
  });

  it('超时：截止后锁自动释放，可被重新领取', () => {
    const { c } = fixture();
    const t0 = 5_000_000;
    const TIMEOUT = 1000;
    let doc = claimConflict(emptyDoc(), c.key, c.fingerprint, '审校小林', t0, TIMEOUT);
    expect(doc.handoffs[c.key].deadline).toBe(t0 + TIMEOUT);
    expect(getLock(doc, c.key, t0 + 500).locked).toBe(true);

    // 未到期扫描不变
    expect(expireLocks(doc, t0 + 999).expired).toEqual([]);
    const r = expireLocks(doc, t0 + 1001);
    expect(r.expired).toEqual([c.key]);
    doc = r.doc;
    expect(doc.handoffs[c.key].status).toBe('timeout');
    expect(getLock(doc, c.key, t0 + 1001).locked).toBe(false);

    doc = claimConflict(doc, c.key, c.fingerprint, '审校老周', t0 + 1100, TIMEOUT);
    expect(doc.handoffs[c.key].owner).toBe('审校老周');
    expect(doc.handoffs[c.key].deadline).toBe(t0 + 2100);
  });

  it('重复提交完全相同的裁决会被拒绝，提交不同裁决允许', () => {
    const { c } = fixture();
    const t0 = 6_000_000;
    const submit = (doc: ReturnType<typeof emptyDoc>, who: string) =>
      applyResolution(doc, {
        key: c.key,
        fingerprint: c.fingerprint,
        resolution: { choice: 'legal' },
        who,
        now: t0,
      });
    let doc = submit(emptyDoc(), '编辑甲');
    expectError(() => submit(doc, '编辑甲'), 'duplicate');
    // 换一个裁决不算重复
    doc = applyResolution(doc, {
      key: c.key,
      fingerprint: c.fingerprint,
      resolution: { choice: 'brand' },
      who: '编辑甲',
      now: t0 + 10,
    });
    expect(doc.resolutions[c.key].choice).toBe('brand');
  });

  it('手动裁决的重复提交按内容判重', () => {
    const { c } = fixture();
    const t0 = 7_000_000;
    const mk = (text: string) =>
      applyResolution(emptyDoc(), {
        key: c.key,
        fingerprint: c.fingerprint,
        resolution: { choice: 'manual', manualText: text },
        who: '编辑甲',
        now: t0,
      });
    let doc = mk('终稿');
    expectError(
      () =>
        applyResolution(doc, {
          key: c.key,
          fingerprint: c.fingerprint,
          resolution: { choice: 'manual', manualText: '终稿' },
          who: '编辑甲',
          now: t0 + 10,
        }),
      'duplicate',
    );
    doc = applyResolution(doc, {
      key: c.key,
      fingerprint: c.fingerprint,
      resolution: { choice: 'manual', manualText: '终稿v2' },
      who: '编辑甲',
      now: t0 + 20,
    });
    expect(doc.resolutions[c.key].manualText).toBe('终稿v2');
  });

  it('重新打开受锁定保护，打开后裁决删除且锁释放', () => {
    const { c } = fixture();
    const t0 = 8_000_000;
    let doc = applyResolution(emptyDoc(), {
      key: c.key,
      fingerprint: c.fingerprint,
      resolution: { choice: 'legal' },
      who: '编辑甲',
      now: t0,
    });
    doc = unresolveConflict(doc, c.key, '编辑甲', t0 + 10);
    expect(doc.resolutions[c.key]).toBeUndefined();
    expect(doc.handoffs[c.key].status).toBe('returned');
    // 没有裁决时再打开是空操作
    expect(unresolveConflict(doc, c.key, '编辑甲', t0 + 20)).toBe(doc);
  });
});

describe('来源文稿变化后的对账', () => {
  it('身份稳定：编辑双方文字 key 不变，指纹变化', () => {
    const { c, base, legal } = fixture();
    const next = buildMergedDocument(base, ['一', '二品牌改', '三'], legal, {});
    const nc = next.conflicts[0];
    expect(nc.key).toBe(c.key);
    expect(nc.fingerprint).not.toBe(c.fingerprint);
  });

  it('在底稿别处插入段落导致下标移动，身份与记录原样保留', () => {
    const { base, brand, legal, c } = fixture();
    let doc = applyResolution(emptyDoc(), {
      key: c.key,
      fingerprint: c.fingerprint,
      resolution: { choice: 'legal' },
      who: '编辑甲',
      now: 100,
    });
    // 底稿文首插入一段，品牌/法务也插入对应段，冲突段落下标平移
    const b2 = ['新首段', ...base];
    const br2 = ['新首段', ...brand];
    const le2 = ['新首段', ...legal];
    const next = buildMergedDocument(b2, br2, le2, doc.resolutions);
    const nc = next.conflicts[0];
    expect(nc.baseIdx).toBe(2);
    expect(nc.key).toBe(c.key);
    const r = reconcileDoc(doc, next.conflicts, 200);
    expect(r.reviewKeys.size).toBe(0);
    expect(r.doc).toBe(doc);
    // 旧裁决直接生效
    const resolved = buildMergedDocument(b2, br2, le2, doc.resolutions, {
      reviewKeys: r.reviewKeys,
    });
    expect(resolved.stats.resolved).toBe(1);
  });

  it('移动类冲突：锚点下标平移（在底稿他处插段）不改变身份', () => {
    const base = ['一', '二', '三', '四', '五'];
    const brand = ['一', '三', '四', '五', '二']; // 移到末尾
    const legal = ['一', '三', '二', '四', '五']; // 移到"三"后
    const m = buildMergedDocument(base, brand, legal, {});
    expect(m.conflicts[0].type).toBe('move-move');
    const c = m.conflicts[0];

    // 在文首插入一段；品牌/法务同样插入，锚点下标整体 +1 但锚点段落文本不变
    const base2 = ['新首段', ...base];
    const brand2 = ['新首段', ...brand];
    const legal2 = ['新首段', ...legal];
    const m2 = buildMergedDocument(base2, brand2, legal2, {});
    const c2 = m2.conflicts[0];
    expect(c2.baseIdx).toBe(c.baseIdx + 1);
    expect(c2.key).toBe(c.key);
    expect(c2.fingerprint).toBe(c.fingerprint);
  });

  it('受影响的裁决进入待复核且不参与合并，未受影响的裁决保留', () => {
    const { base, legal, c1, c2 } = twoConflictFixture();
    let doc = emptyDoc();
    doc = applyResolution(doc, {
      key: c1.key,
      fingerprint: c1.fingerprint,
      resolution: { choice: 'legal' },
      who: '编辑甲',
      now: 100,
    });
    doc = applyResolution(doc, {
      key: c2.key,
      fingerprint: c2.fingerprint,
      resolution: { choice: 'brand' },
      who: '编辑甲',
      now: 100,
    });

    // 只改 c1 对应段落的品牌文本
    const nextBrand = ['一', '二B-更新', '三', '四B'];
    const next = buildMergedDocument(base, nextBrand, legal, doc.resolutions);
    const nc1 = next.conflicts.find((x) => x.key === c1.key)!;
    expect(nc1.fingerprint).not.toBe(c1.fingerprint);

    const r = reconcileDoc(doc, next.conflicts, 200);
    expect([...r.reviewKeys]).toEqual([c1.key]);
    // 旧裁决仍保留
    expect(r.doc.resolutions[c1.key].choice).toBe('legal');
    expect(r.doc.handoffs[c1.key].status).toBe('review');

    const effective = { ...r.doc.resolutions };
    for (const k of r.reviewKeys) delete effective[k];
    const merged = buildMergedDocument(base, nextBrand, legal, effective, {
      reviewKeys: r.reviewKeys,
    });
    const block1 = merged.blocks.find((b) => b.conflictId === nc1.id)!;
    expect(block1.status).toBe('review');
    expect(merged.stats.needsReview).toBe(1);
    expect(merged.stats.resolved).toBe(1);
    expect(merged.stats.pending).toBe(1);
    // 待复核段在导出文本中带显式标记，不会被当作已定稿
    const exported = exportMergedText(merged);
    expect(exported).toContain('【待复核冲突');
    expect(exported).toContain('旧裁决暂不生效');
  });

  it('交接中的项目来源变化后挂起锁，确认后恢复交接', () => {
    const { base, legal, c } = fixture();
    const t0 = 9_000_000;
    let doc = claimConflict(emptyDoc(), c.key, c.fingerprint, '审校小林', t0, 1000);

    const next = buildMergedDocument(base, ['一', '二品牌改', '三'], legal, {});
    const r = reconcileDoc(doc, next.conflicts, t0 + 100);
    expect([...r.reviewKeys]).toEqual([c.key]);
    expect(r.doc.handoffs[c.key].status).toBe('review');
    // 待复核期间锁挂起：其他人也看不到锁定
    expect(getLock(r.doc, c.key, t0 + 100).locked).toBe(false);

    // 恢复交接，回到 claimed 并重新计时
    doc = confirmReview(r.doc, c.key, next.conflicts[0].fingerprint, '审校小林', t0 + 200, 1000);
    expect(doc.handoffs[c.key].status).toBe('claimed');
    expect(doc.handoffs[c.key].owner).toBe('审校小林');
    expect(doc.handoffs[c.key].deadline).toBe(t0 + 1200);
    expect(getLock(doc, c.key, t0 + 300).owner).toBe('审校小林');
  });

  it('复核时沿用原裁决：指纹刷新，交接记为完成', () => {
    const { base, legal, c } = fixture();
    let doc = applyResolution(emptyDoc(), {
      key: c.key,
      fingerprint: c.fingerprint,
      resolution: { choice: 'legal' },
      who: '审校小林',
      now: 100,
    });
    const next = buildMergedDocument(base, ['一', '二品牌改', '三'], legal, {});
    const r = reconcileDoc(doc, next.conflicts, 200);
    expect(computeReviewKeys(r.doc, next.conflicts).size).toBe(1);

    doc = confirmReview(r.doc, c.key, next.conflicts[0].fingerprint, '审校小林', 300);
    expect(doc.handoffs[c.key].status).toBe('done');
    expect(computeReviewKeys(doc, next.conflicts).size).toBe(0);
    const merged = buildMergedDocument(base, ['一', '二品牌改', '三'], legal, doc.resolutions);
    expect(merged.stats.resolved).toBe(1);
  });

  it('底稿段落本身被原地改写：身份重映射到新 key 并进入待复核', () => {
    const { base, brand, legal, c, merge } = fixture();
    let doc = applyResolution(emptyDoc(), {
      key: c.key,
      fingerprint: c.fingerprint,
      resolution: { choice: 'legal' },
      who: '编辑甲',
      now: 100,
    });
    // 直接改写冲突所在的底稿段（保持两侧仍能配对为同一处冲突）
    const newBase = ['一', '二改', '三'];
    const nextMerge = buildMergedDocument(newBase, brand, legal, {});
    const nc = nextMerge.conflicts[0];
    expect(nc.key).not.toBe(c.key);

    const remapped = remapDocAfterBaseEdit({
      oldBase: base,
      newBase,
      oldConflicts: merge.conflicts,
      newConflicts: nextMerge.conflicts,
      doc,
    });
    expect(remapped.resolutions[nc.key]?.choice).toBe('legal');
    expect(remapped.resolutions[c.key]).toBeUndefined();
    // 指纹保留旧值 → 与新指纹不一致，自然进入待复核
    const r = reconcileDoc(remapped, nextMerge.conflicts, 200);
    expect([...r.reviewKeys]).toEqual([nc.key]);
  });
});

describe('旧版本迁移', () => {
  it('按下标 id 保存的 v1 裁决迁移到稳定 key', () => {
    const { c, merge } = fixture();
    const doc = migrateLegacyResolutions({ [c.id]: { choice: 'legal' } }, merge.conflicts);
    expect(doc.resolutions[c.key]?.choice).toBe('legal');
    expect(doc.fingerprints[c.key]).toBe(c.fingerprint);
    expect(doc.handoffs[c.key].status).toBe('done');
  });
});
