/**
 * 底稿编辑后的冲突身份重映射。
 *
 * key 锚定的是底稿段落文本；当编辑的正是冲突所在的底稿段时，新旧 key 会不同。
 * 用 alignVersion 把旧底稿段落对齐到新底稿段落，配合相似度判定为"同一处冲突"后，
 * 把按旧 key 保存的裁决/交接/指纹平移到新 key（指纹保留旧值 → 随后自然进入待复核）。
 */
import { alignVersion } from './align';
import type { Conflict } from './merge';
import { similarity } from './similarity';
import type { WorkbenchDoc } from './handoff';

const SIMILARITY_THRESHOLD = 0.6;

export function remapDocAfterBaseEdit(input: {
  oldBase: string[];
  newBase: string[];
  oldConflicts: Conflict[];
  newConflicts: Conflict[];
  doc: WorkbenchDoc;
}): WorkbenchDoc {
  const { oldBase, newBase, oldConflicts, newConflicts, doc } = input;
  const align = alignVersion(oldBase, newBase);
  const oldByBase = new Map(oldConflicts.map((c) => [c.baseIdx, c]));
  const occupied = new Set(
    Object.keys(doc.resolutions).concat(Object.keys(doc.handoffs)),
  );

  const keyMap = new Map<string, string>();
  for (const nc of newConflicts) {
    const pair = align.pairs.find((p) => p.verIdx === nc.baseIdx);
    if (!pair) continue;
    const oc = oldByBase.get(pair.baseIdx);
    if (!oc || oc.type !== nc.type || oc.key === nc.key) continue;
    // 段落被改得面目全非时不做自动认领
    if (pair.modified && similarity(oc.baseText, nc.baseText) < SIMILARITY_THRESHOLD) continue;
    // 新 key 上已有记录则不覆盖
    if (occupied.has(nc.key)) continue;
    if (!occupied.has(oc.key)) continue;
    keyMap.set(oc.key, nc.key);
  }

  if (keyMap.size === 0) return doc;

  const next: WorkbenchDoc = {
    resolutions: { ...doc.resolutions },
    handoffs: { ...doc.handoffs },
    fingerprints: { ...doc.fingerprints },
  };
  for (const [oldKey, newKey] of keyMap) {
    if (next.resolutions[newKey] || next.handoffs[newKey]) continue;
    if (next.resolutions[oldKey]) {
      next.resolutions[newKey] = next.resolutions[oldKey];
    }
    delete next.resolutions[oldKey];

    const h = next.handoffs[oldKey];
    if (h) next.handoffs[newKey] = { ...h, conflictKey: newKey };
    delete next.handoffs[oldKey];

    if (next.fingerprints[oldKey] !== undefined) {
      next.fingerprints[newKey] = next.fingerprints[oldKey];
      delete next.fingerprints[oldKey];
    }
  }
  return next;
}
