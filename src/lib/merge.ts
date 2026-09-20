import { alignVersion, type Alignment } from './align';
import { hashString, normalizeText } from './text';

/**
 * 三方段落合并引擎。
 *
 * 对底稿的每个段落分别做"存在性 / 位置 / 内容"三个维度的裁决：
 * - 只有一方修改（或双方改得一样）→ 自动采用；
 * - 双方都改了同一段且结果不同 → edit-edit 冲突；
 * - 一方删除、另一方修改 → delete-edit 冲突；一方删除、另一方移动 → delete-move 冲突；
 * - 双方把同一段移到不同位置 → move-move 冲突；
 * - 一方移动、另一方只改内容 → 自动合并：保留新位置，同时采用新内容（不会误判成删除+新增）。
 */

export type Side = 'brand' | 'legal';

export type ConflictType = 'edit-edit' | 'delete-edit' | 'delete-move' | 'move-move';

export type Choice = 'brand' | 'legal' | 'base' | 'manual';

export interface Resolution {
  choice: Choice;
  manualText?: string;
}

/** 冲突 id -> 人工裁决结果 */
export type Resolutions = Record<string, Resolution>;

export interface Conflict {
  id: string;
  /**
   * 稳定身份：仅由冲突内容（底稿/双方文本、移动锚点、冲突类型）派生，
   * 与段落下标无关。来源文稿编辑后，同一处冲突仍能据此找回裁决与交接记录。
   */
  key: string;
  /** 内容指纹：来源变化导致指纹变化时，已保存的裁决/交接需要重新确认 */
  fingerprint: string;
  type: ConflictType;
  baseIdx: number;
  baseText: string;
  /** 该侧段落文本；null 表示该侧删除了此段 */
  brandText: string | null;
  legalText: string | null;
  /** 该侧若移动了此段，记录移动锚点（位于底稿第 anchor 段之后，-1 为文首） */
  brandAnchor: number | null;
  legalAnchor: number | null;
}

export type Provenance = 'base' | 'brand' | 'legal' | 'both' | 'manual';

export interface MoveInfo {
  by: Side[];
  fromBaseIdx: number;
  anchorBaseIdx: number;
}

export interface MergedBlock {
  id: string;
  /** 来源底稿段落下标；新增段落为 null */
  baseIdx: number | null;
  /** 应用裁决后的最终文本（未解决冲突为默认文本） */
  text: string;
  /** review = 来源文稿已变化，旧裁决/交接被标记为待复核，不能直接提交/导出 */
  status: 'auto' | 'pending' | 'review' | 'resolved' | 'removed';
  provenance: Provenance;
  /** 内容相对底稿被哪些方修改过 */
  changedBy: Side[];
  moved: MoveInfo | null;
  conflictId: string | null;
  resolution?: Resolution;
  /** 因裁决而被删除时，记录采用哪一侧的删除意见 */
  removedBy?: Side;
  insertedBy: Side[];
  /** 各版本中的段落下标，用于界面交叉定位 */
  sourceIdx: { brand: number | null; legal: number | null };
}

export interface MergeStats {
  total: number;
  unchanged: number;
  autoChanged: number;
  inserted: number;
  autoDeleted: number;
  removedByResolution: number;
  moved: number;
  pending: number;
  resolved: number;
  /** 来源更新后需要重新确认的冲突数（旧裁决或交接仍保留，但暂不生效） */
  needsReview: number;
}

export interface MergeResult {
  blocks: MergedBlock[];
  conflicts: Conflict[];
  stats: MergeStats;
  alignments: { brand: Alignment; legal: Alignment };
}

interface SideState {
  present: boolean;
  verIdx: number | null;
  text: string | null;
  moved: boolean;
  modified: boolean;
  /** 移动锚点（仅 moved 时有效，-1 表示移到文首） */
  anchor: number | null;
}

/** 锚点身份：用锚点段落文本而非下标，底稿他处增删段落导致下标平移时身份不变。 */
function anchorRef(anchor: number | null, base: string[]): string {
  if (anchor === null) return '';
  if (anchor < 0) return '文首';
  return normalizeText(base[anchor] ?? '');
}

/** 冲突内容指纹的原始材料：含三方全部文本，任一侧内容变化都会改变。 */
function conflictFingerprint(
  c: Omit<Conflict, 'key' | 'fingerprint'>,
  base: string[],
): string {
  return hashString(
    [
      c.type,
      normalizeText(c.baseText),
      c.brandText === null ? '∅' : normalizeText(c.brandText),
      c.legalText === null ? '∅' : normalizeText(c.legalText),
      `ba:${anchorRef(c.brandAnchor, base)}`,
      `la:${anchorRef(c.legalAnchor, base)}`,
    ].join('|'),
  );
}

/**
 * 稳定身份：只锚定"底稿哪一段 + 冲突类型 + 移动结构"，不含双方改写内容。
 * 因此编辑品牌版/法务版文字、在底稿别处增删段落导致下标移动，都不会改变身份；
 * 身份找到后再用 fingerprint 判断内容是否已变化（待复核）。
 */
export function makeConflictKey(
  c: Pick<Conflict, 'type' | 'baseText' | 'brandAnchor' | 'legalAnchor'>,
  base: string[],
): string {
  return `k${hashString(
    [
      c.type,
      normalizeText(c.baseText),
      `ba:${anchorRef(c.brandAnchor, base)}`,
      `la:${anchorRef(c.legalAnchor, base)}`,
    ].join('|'),
  )}`;
}

/** 给冲突补上稳定身份 key 与内容指纹。 */
function withIdentity<C extends Omit<Conflict, 'key' | 'fingerprint'>>(c: C, base: string[]): Conflict {
  return { ...c, key: makeConflictKey(c, base), fingerprint: conflictFingerprint(c, base) };
}

export interface MergeOptions {
  /** 来源文稿已变化、需要重新确认的冲突 key 集合；这些冲突即使有旧裁决也按待复核处理 */
  reviewKeys?: ReadonlySet<string>;
}

function statesFor(align: Alignment, ver: string[], baseLen: number): SideState[] {
  const byBase = new Map(align.pairs.map((p) => [p.baseIdx, p]));
  const out: SideState[] = [];
  for (let i = 0; i < baseLen; i++) {
    const p = byBase.get(i);
    if (p) {
      out.push({
        present: true,
        verIdx: p.verIdx,
        text: ver[p.verIdx],
        moved: p.moved,
        modified: p.modified,
        anchor: p.moved ? align.anchorOf.get(p.verIdx) ?? -1 : null,
      });
    } else {
      out.push({ present: false, verIdx: null, text: null, moved: false, modified: false, anchor: null });
    }
  }
  return out;
}

interface Item {
  /** 排序槽位：原地段落 = 底稿下标；移动/新增段落 = 锚点下标 + 0.5 */
  slot: number;
  order: number;
  block: MergedBlock;
}

/** 内容三方裁决：两方一致用一致值，否则看哪方没动。 */
function autoContent(baseText: string, brandText: string, legalText: string): string {
  const nb = normalizeText(baseText);
  const nbr = normalizeText(brandText);
  const nl = normalizeText(legalText);
  if (nbr === nl) return brandText;
  if (nbr === nb) return legalText;
  if (nl === nb) return brandText;
  return baseText;
}

function buildConflictItem(
  conflict: Conflict,
  auto: { slot: number; anchor: number | null },
  movedBy: Side[],
  resolution: Resolution | undefined,
  states: { b: SideState; l: SideState },
  underReview: boolean,
): Item {
  const c = conflict;
  const i = c.baseIdx;
  const moverSide: Side | null =
    c.type === 'delete-move' ? (states.b.present && states.b.moved ? 'brand' : 'legal') : null;
  const moverAnchor = moverSide === 'brand' ? c.brandAnchor : moverSide === 'legal' ? c.legalAnchor : null;

  let text: string;
  let slot: number;
  let status: MergedBlock['status'];
  let provenance: Provenance;
  let removedBy: Side | undefined;
  let moved: MoveInfo | null = null;

  if (!resolution) {
    status = 'pending';
    provenance = 'base';
    switch (c.type) {
      case 'edit-edit':
        // 位置无争议（可能已被一方移动），内容暂保留底稿原文
        text = c.baseText;
        slot = auto.slot;
        if (movedBy.length > 0 && auto.anchor !== null) {
          moved = { by: movedBy, fromBaseIdx: i, anchorBaseIdx: auto.anchor };
        }
        break;
      case 'move-move':
        // 位置有争议，暂放回原位；内容能自动合并则自动合并
        text = autoContent(c.baseText, c.brandText ?? c.baseText, c.legalText ?? c.baseText);
        slot = i;
        break;
      case 'delete-edit':
        // 暂保留被修改后的内容，等待人工确认
        text = (c.brandText ?? c.legalText)!;
        slot = i;
        break;
      case 'delete-move':
        // 暂按移动方放在新位置，等待人工确认
        text = (c.brandText ?? c.legalText)!;
        slot = (moverAnchor ?? i) + 0.5;
        moved = { by: [moverSide!], fromBaseIdx: i, anchorBaseIdx: moverAnchor ?? i };
        break;
    }
  } else {
    switch (resolution.choice) {
      case 'brand':
      case 'legal': {
        const side = resolution.choice;
        const sideText = side === 'brand' ? c.brandText : c.legalText;
        const sideAnchor = side === 'brand' ? c.brandAnchor : c.legalAnchor;
        provenance = side;
        if (sideText === null) {
          // 该侧的意见是删除此段
          status = 'removed';
          removedBy = side;
          text = c.baseText;
          slot = i;
        } else {
          status = 'resolved';
          text = sideText;
          if (c.type === 'move-move' || c.type === 'delete-move') {
            // 位置争议随所选一侧落定
            slot = sideAnchor !== null ? sideAnchor + 0.5 : i;
            if (sideAnchor !== null) moved = { by: [side], fromBaseIdx: i, anchorBaseIdx: sideAnchor };
          } else {
            slot = auto.slot;
            if (movedBy.length > 0 && auto.anchor !== null) {
              moved = { by: movedBy, fromBaseIdx: i, anchorBaseIdx: auto.anchor };
            }
          }
        }
        break;
      }
      case 'base':
        status = 'resolved';
        provenance = 'base';
        text = c.baseText;
        slot = i;
        break;
      case 'manual':
        status = 'resolved';
        provenance = 'manual';
        text = resolution.manualText ?? '';
        slot = i;
        break;
    }
  }

  const changedBy: Side[] = [];
  if (states.b.modified) changedBy.push('brand');
  if (states.l.modified) changedBy.push('legal');

  if (underReview) {
    // 来源文稿已变化：旧裁决（若有）保留备查，但本块视为待复核，不能当作已定稿
    status = 'review';
  }

  return {
    slot,
    order: i,
    block: {
      id: `b${i}`,
      baseIdx: i,
      text,
      status,
      provenance,
      changedBy,
      moved,
      conflictId: c.id,
      resolution,
      removedBy,
      insertedBy: [],
      sourceIdx: { brand: states.b.verIdx, legal: states.l.verIdx },
    },
  };
}

export function buildMergedDocument(
  base: string[],
  brand: string[],
  legal: string[],
  resolutions: Resolutions,
  options: MergeOptions = {},
): MergeResult {
  const reviewKeys = options.reviewKeys ?? new Set<string>();
  const alignBrand = alignVersion(base, brand);
  const alignLegal = alignVersion(base, legal);
  const sb = statesFor(alignBrand, brand, base.length);
  const sl = statesFor(alignLegal, legal, base.length);

  const conflicts: Conflict[] = [];
  const items: Item[] = [];
  let autoDeleted = 0;

  for (let i = 0; i < base.length; i++) {
    const b = sb[i];
    const l = sl[i];
    const baseText = base[i];

    // 双方都删除
    if (!b.present && !l.present) {
      autoDeleted++;
      continue;
    }

    // 移动目标集合（锚点，-1 表示文首）
    const moveTargets = new Set<number>();
    if (b.present && b.moved && b.anchor !== null) moveTargets.add(b.anchor);
    if (l.present && l.moved && l.anchor !== null) moveTargets.add(l.anchor);
    const autoAnchor = moveTargets.size === 1 ? [...moveTargets][0] : null;
    const auto = { slot: autoAnchor !== null ? autoAnchor + 0.5 : i, anchor: autoAnchor };
    const movedBy: Side[] = [];
    if (b.moved) movedBy.push('brand');
    if (l.moved) movedBy.push('legal');

    // 只有一方删除
    if (!b.present || !l.present) {
      const other = b.present ? b : l;
      if (other.modified || other.moved) {
        // 另一方动了它（改内容或挪位置）→ 冲突
        const type: ConflictType = other.moved ? 'delete-move' : 'delete-edit';
        const conflict = withIdentity({
          id: `c${i}`,
          type,
          baseIdx: i,
          baseText,
          brandText: b.text,
          legalText: l.text,
          brandAnchor: b.moved ? b.anchor : null,
          legalAnchor: l.moved ? l.anchor : null,
        }, base);
        conflicts.push(conflict);
        items.push(
          buildConflictItem(
            conflict,
            auto,
            movedBy,
            resolutions[conflict.key] ?? resolutions[conflict.id],
            { b, l },
            reviewKeys.has(conflict.key),
          ),
        );
      } else {
        // 另一方没动 → 自动删除
        autoDeleted++;
      }
      continue;
    }

    const contentConflict =
      b.modified && l.modified && normalizeText(b.text!) !== normalizeText(l.text!);
    const positionConflict = moveTargets.size > 1;

    if (positionConflict || contentConflict) {
      const conflict = withIdentity({
        id: `c${i}`,
        type: positionConflict ? 'move-move' : 'edit-edit',
        baseIdx: i,
        baseText,
        brandText: b.text,
        legalText: l.text,
        brandAnchor: b.moved ? b.anchor : null,
        legalAnchor: l.moved ? l.anchor : null,
      }, base);
      conflicts.push(conflict);
      items.push(
        buildConflictItem(
          conflict,
          auto,
          movedBy,
          resolutions[conflict.key] ?? resolutions[conflict.id],
          { b, l },
          reviewKeys.has(conflict.key),
        ),
      );
      continue;
    }

    // 自动合并：内容取改动方（或双方一致值），位置取唯一移动目标
    const changedBy: Side[] = [];
    if (b.modified) changedBy.push('brand');
    if (l.modified) changedBy.push('legal');
    const text = b.modified ? b.text! : l.modified ? l.text! : baseText;
    items.push({
      slot: auto.slot,
      order: i,
      block: {
        id: `b${i}`,
        baseIdx: i,
        text,
        status: 'auto',
        provenance: changedBy.length === 0 ? 'base' : changedBy.length === 2 ? 'both' : changedBy[0],
        changedBy,
        moved:
          movedBy.length > 0 && autoAnchor !== null
            ? { by: movedBy, fromBaseIdx: i, anchorBaseIdx: autoAnchor }
            : null,
        conflictId: null,
        insertedBy: [],
        sourceIdx: { brand: b.verIdx, legal: l.verIdx },
      },
    });
  }

  // 新增段落：双方在同锚点插入相同内容时去重为一段
  interface InsAgg {
    anchor: number;
    text: string;
    sides: Side[];
    verIdxs: { brand: number | null; legal: number | null };
  }
  const insMap = new Map<string, InsAgg>();
  const collectInsertions = (align: Alignment, ver: string[], side: Side) => {
    for (const ins of align.inserted) {
      const text = ver[ins.verIdx];
      const key = `${ins.anchor}::${normalizeText(text)}`;
      const existing = insMap.get(key);
      if (existing) {
        existing.sides.push(side);
        existing.verIdxs[side] = ins.verIdx;
      } else {
        const verIdxs: { brand: number | null; legal: number | null } = { brand: null, legal: null };
        verIdxs[side] = ins.verIdx;
        insMap.set(key, { anchor: ins.anchor, text, sides: [side], verIdxs });
      }
    }
  };
  collectInsertions(alignBrand, brand, 'brand');
  collectInsertions(alignLegal, legal, 'legal');
  let insCounter = 0;
  for (const ins of insMap.values()) {
    items.push({
      slot: ins.anchor + 0.5,
      order: 10000 + insCounter,
      block: {
        id: `ins${insCounter}`,
        baseIdx: null,
        text: ins.text,
        status: 'auto',
        provenance: ins.sides.length === 2 ? 'both' : ins.sides[0],
        changedBy: [...ins.sides],
        moved: null,
        conflictId: null,
        insertedBy: [...ins.sides],
        sourceIdx: { brand: ins.verIdxs.brand, legal: ins.verIdxs.legal },
      },
    });
    insCounter++;
  }

  items.sort((x, y) => x.slot - y.slot || x.order - y.order);
  const blocks = items.map((it) => it.block);
  conflicts.sort((x, y) => x.baseIdx - y.baseIdx);

  const stats: MergeStats = {
    total: blocks.filter((b) => b.status !== 'removed').length,
    unchanged: blocks.filter(
      (b) => b.status === 'auto' && b.changedBy.length === 0 && b.moved === null && b.insertedBy.length === 0,
    ).length,
    autoChanged: blocks.filter(
      (b) => b.status === 'auto' && b.insertedBy.length === 0 && (b.changedBy.length > 0 || b.moved !== null),
    ).length,
    inserted: blocks.filter((b) => b.insertedBy.length > 0).length,
    autoDeleted,
    removedByResolution: blocks.filter((b) => b.status === 'removed').length,
    moved: blocks.filter((b) => b.moved !== null && b.status !== 'removed').length,
    pending: conflicts.filter(
      (c) => !(resolutions[c.key] ?? resolutions[c.id]) || reviewKeys.has(c.key),
    ).length,
    resolved: conflicts.filter(
      (c) => (resolutions[c.key] ?? resolutions[c.id]) && !reviewKeys.has(c.key),
    ).length,
    needsReview: conflicts.filter((c) => reviewKeys.has(c.key)).length,
  };

  return {
    blocks,
    conflicts,
    stats,
    alignments: { brand: alignBrand, legal: alignLegal },
  };
}

/** 导出合并稿纯文本；未解决/待复核冲突以标记行保留，避免被当成已定稿内容直接使用。 */
export function exportMergedText(merge: MergeResult): string {
  return merge.blocks
    .filter((b) => b.status !== 'removed')
    .map((b) => {
      if (b.status === 'pending') {
        return `【未解决冲突 · 底稿第${(b.baseIdx ?? 0) + 1}段，暂保留底稿原文】\n${b.text}`;
      }
      if (b.status === 'review') {
        return `【待复核冲突 · 底稿第${(b.baseIdx ?? 0) + 1}段，来源文稿已更新，旧裁决暂不生效】\n${b.text}`;
      }
      return b.text;
    })
    .join('\n\n');
}
