import type { MergeStats } from '../lib/merge';
import type { Handoffs } from '../lib/handoff';

interface SummaryBarProps {
  stats: MergeStats;
  handoffs: Handoffs;
}

export function SummaryBar({ stats, handoffs }: SummaryBarProps) {
  const handoffCount = Object.values(handoffs).filter(
    (h) => h.status === 'assigned' || h.status === 'claimed',
  ).length;
  return (
    <div className="summary-bar">
      <span className="stat" data-testid="stat-total">
        共 <b>{stats.total}</b> 段
      </span>
      <span className="stat" data-testid="stat-unchanged">
        未改动 <b>{stats.unchanged}</b>
      </span>
      <span className="stat stat-ok" data-testid="stat-auto">
        ✎ 自动合并 <b>{stats.autoChanged}</b>
      </span>
      <span className="stat" data-testid="stat-inserted">
        ＋ 新增 <b>{stats.inserted}</b>
      </span>
      <span className="stat" data-testid="stat-deleted">
        ✕ 删除 <b>{stats.autoDeleted + stats.removedByResolution}</b>
      </span>
      <span className="stat" data-testid="stat-moved">
        ⇄ 移动 <b>{stats.moved}</b>
      </span>
      <span className="stat stat-handoff" data-testid="stat-handoff">
        🔒 交接中 <b>{handoffCount}</b>
      </span>
      {stats.needsReview > 0 && (
        <span className="stat stat-review" data-testid="stat-review">
          ↻ 待复核 <b>{stats.needsReview}</b>
        </span>
      )}
      <span className="stat stat-warn" data-testid="stat-pending">
        ⚠ 待解决 <b>{stats.pending}</b>
      </span>
      <span className="stat stat-done" data-testid="stat-resolved">
        ✓ 已解决 <b>{stats.resolved}</b>
      </span>
    </div>
  );
}
