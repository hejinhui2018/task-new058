import type { Conflict, ConflictType, Resolutions } from '../lib/merge';
import type { Handoffs } from '../lib/handoff';

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
  reviewKeys: ReadonlySet<string>;
  identity: string;
  activeConflict: number;
  onJump: (index: number) => void;
}

export function ConflictSidebar({
  conflicts,
  resolutions,
  handoffs,
  reviewKeys,
  identity,
  activeConflict,
  onJump,
}: ConflictSidebarProps) {
  const pendingCount = conflicts.filter(
    (c) => !resolutions[c.key] || reviewKeys.has(c.key),
  ).length;
  return (
    <aside className="conflict-sidebar">
      <div className="sidebar-title">冲突列表（{conflicts.length}）</div>
      {conflicts.length === 0 && <div className="sidebar-note">🎉 没有冲突，全部自动合并</div>}
      {conflicts.length > 0 && pendingCount === 0 && (
        <div className="sidebar-note sidebar-done">🎉 全部冲突已解决</div>
      )}
      <ul className="conflict-nav-list">
        {conflicts.map((c, i) => {
          const res = resolutions[c.key];
          const h = handoffs[c.key];
          const review = reviewKeys.has(c.key);
          let stateClass = 'is-pending';
          let icon = '⚠';
          let statusText = '待解决';
          if (review) {
            stateClass = 'is-review';
            icon = '↻';
            statusText = '待复核';
          } else if (res) {
            stateClass = 'is-resolved';
            icon = '✓';
            statusText = CHOICE_LABEL[res.choice];
          } else if (h && (h.status === 'claimed' || h.status === 'assigned')) {
            stateClass = 'is-locked';
            icon = '🔒';
            statusText = h.owner === identity ? `你处理中` : `${handoffs[c.key]?.owner ?? '审校'}处理中`;
          } else if (h?.status === 'timeout') {
            statusText = '已超时';
          } else if (h?.status === 'returned') {
            statusText = '已退回';
          }
          return (
            <li key={c.key}>
              <button
                className={`conflict-nav-item ${i === activeConflict ? 'is-active' : ''} ${stateClass}`}
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
