import type { Conflict, ConflictType, Resolutions } from '../lib/merge';
import { handoffStatus, isHandoffLocked, type Handoffs } from '../state/handoff';

export const CONFLICT_TYPE_LABEL: Record<ConflictType, string> = {
  'edit-edit': '双方修改了同一段落',
  'delete-edit': '一方删除 · 另一方修改',
  'delete-move': '一方删除 · 另一方移动',
  'move-move': '双方移动位置不一致',
};

const CONFLICT_TYPE_SHORT: Record<ConflictType, string> = {
  'edit-edit': '双方修改',
  'delete-edit': '删除 vs 修改',
  'delete-move': '删除 vs 移动',
  'move-move': '移动分歧',
};

export const CHOICE_LABEL: Record<string, string> = {
  brand: '采用品牌版',
  legal: '采用法务版',
  base: '保留底稿',
  manual: '手动填写',
};

interface ConflictSidebarProps {
  conflicts: Conflict[];
  resolutions: Resolutions;
  handoffs: Handoffs;
  now: number;
  activeConflict: number;
  onJump: (index: number) => void;
}

export function ConflictSidebar({
  conflicts,
  resolutions,
  handoffs,
  now,
  activeConflict,
  onJump,
}: ConflictSidebarProps) {
  const pendingCount = conflicts.filter((c) => !resolutions[c.id]).length;
  return (
    <aside className="conflict-sidebar">
      <div className="sidebar-title">冲突列表（{conflicts.length}）</div>
      {conflicts.length === 0 && <div className="sidebar-note">🎉 没有冲突，全部自动合并</div>}
      {conflicts.length > 0 && pendingCount === 0 && (
        <div className="sidebar-note sidebar-done">🎉 全部冲突已解决</div>
      )}
      <ul className="conflict-nav-list">
        {conflicts.map((c, i) => {
          const res = resolutions[c.id];
          const handoff = handoffs[c.id];
          const hStatus = !res && handoff ? handoffStatus(handoff, c, now) : null;
          const locked = hStatus !== null && isHandoffLocked(hStatus);
          const icon = res ? '✓' : locked ? '🔒' : hStatus === 'expired' ? '⏰' : '⚠';
          const statusText = res
            ? CHOICE_LABEL[res.choice]
            : hStatus === 'active'
              ? `审校中·${handoff!.reviewer}`
              : hStatus === 'stale'
                ? '待复核'
                : hStatus === 'expired'
                  ? '已超时'
                  : '待解决';
          return (
            <li key={c.id}>
              <button
                className={`conflict-nav-item ${i === activeConflict ? 'is-active' : ''} ${
                  res ? 'is-resolved' : 'is-pending'
                } ${locked ? 'is-locked' : ''}`}
                onClick={() => onJump(i)}
              >
                <span className="nav-icon" aria-hidden>
                  {icon}
                </span>
                <span className="nav-text">
                  第{c.baseIdx + 1}段 · {CONFLICT_TYPE_SHORT[c.type]}
                </span>
                <span className="nav-status">{statusText}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
