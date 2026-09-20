import { useState } from 'react';
import type { Conflict, MergedBlock, Resolution, Side } from '../lib/merge';
import type { Handoff, ReviewerId } from '../lib/handoff';
import { diffTokens } from '../lib/diff';
import { DiffText } from './DiffText';
import { CHOICE_LABEL, CONFLICT_TYPE_LABEL } from './ConflictSidebar';
import { SIDE_FULL_LABEL } from './Badges';

interface ConflictCardProps {
  conflict: Conflict;
  block: MergedBlock;
  resolution: Resolution | undefined;
  handoff: Handoff | undefined;
  underReview: boolean;
  active: boolean;
  highlighted: boolean;
  identity: ReviewerId;
  now: number;
  reviewers: string[];
  onResolve: (key: string, choice: 'brand' | 'legal' | 'base' | 'manual', manualText?: string) => void;
  onUnresolve: (key: string) => void;
  onAssign: (key: string, to: ReviewerId) => void;
  onClaim: (key: string) => void;
  onReturn: (key: string) => void;
  onForward: (key: string, to: ReviewerId) => void;
  onConfirmReview: (key: string) => void;
}

function anchorLabel(anchor: number): string {
  return anchor === -1 ? '移至文首' : `移至第${anchor + 1}段后`;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const HANDOFF_STATUS_LABEL: Record<Handoff['status'], string> = {
  assigned: '已指派',
  claimed: '处理中',
  returned: '已退回',
  timeout: '已超时',
  review: '待复核',
  done: '已完成',
};

/** 交接状态条：指派 / 领取 / 退回 / 转交 / 倒计时。 */
function HandoffBar({
  c,
  handoff,
  identity,
  now,
  reviewers,
  lockedByOther,
  onAssign,
  onClaim,
  onReturn,
  onForward,
}: {
  c: Conflict;
  handoff: Handoff | undefined;
  identity: ReviewerId;
  now: number;
  reviewers: string[];
  lockedByOther: boolean;
  onAssign: (to: ReviewerId) => void;
  onClaim: () => void;
  onReturn: () => void;
  onForward: (to: ReviewerId) => void;
}) {
  const [assignTo, setAssignTo] = useState('');
  const [forwardTo, setForwardTo] = useState('');
  const [showForward, setShowForward] = useState(false);
  const assignListId = `reviewers-assign-${c.key}`;
  const forwardListId = `reviewers-forward-${c.key}`;

  const submitAssign = () => {
    const to = assignTo.trim();
    if (!to) return;
    onAssign(to);
    setAssignTo('');
  };
  const submitForward = () => {
    const to = forwardTo.trim();
    if (!to) return;
    onForward(to);
    setForwardTo('');
    setShowForward(false);
  };

  const status = handoff?.status;
  const iOwn = handoff?.owner === identity && (status === 'claimed' || status === 'assigned');

  return (
    <div className={`handoff-bar handoff-${status ?? 'none'}`}>
      <div className="handoff-line">
        <span className="handoff-label">审校交接</span>
        {handoff && handoff.owner && (
          <span className="handoff-owner">
            {HANDOFF_STATUS_LABEL[handoff.status]} · <b>{handoff.owner}</b>
            {handoff.owner === identity && <span className="handoff-me">（你）</span>}
          </span>
        )}
        {handoff && !handoff.owner && status && status !== 'review' && (
          <span className="handoff-owner">{HANDOFF_STATUS_LABEL[status]} · 等待领取</span>
        )}
        {status === 'review' && !handoff?.owner && (
          <span className="handoff-owner">原处理安排已挂起</span>
        )}
        {handoff?.status === 'claimed' && handoff.deadline !== null && (
          <span
            className={`handoff-timer ${handoff.deadline - now < 60000 ? 'is-urgent' : ''}`}
            data-testid={`timer-${c.key}`}
          >
            剩余 {formatRemaining(handoff.deadline - now)}
          </span>
        )}
      </div>

      <div className="handoff-actions">
        {lockedByOther && (
          <span className="handoff-lock-note">🔒 已锁定给 {handoff!.owner}，你可以继续处理其他冲突</span>
        )}

        {(!handoff || status === 'returned' || status === 'timeout' || status === 'done') && (
          <>
            <input
              className="handoff-input"
              list={assignListId}
              placeholder="指派给审校人…"
              aria-label={`指派 ${c.key} 的审校人`}
              value={assignTo}
              onChange={(e) => setAssignTo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAssign()}
            />
            <datalist id={assignListId}>
              {reviewers.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <button className="btn btn-small" onClick={submitAssign} disabled={!assignTo.trim()}>
              指派
            </button>
            <button className="btn btn-small" onClick={onClaim}>
              我来处理
            </button>
          </>
        )}

        {status === 'assigned' && (
          iOwn ? (
            <>
              <button className="btn btn-small btn-primary" onClick={onClaim}>
                开始处理
              </button>
              <button className="btn btn-small" onClick={onReturn}>
                退回
              </button>
            </>
          ) : (
            <span className="handoff-lock-note">🔒 等待 {handoff!.owner} 领取</span>
          )
        )}

        {status === 'claimed' && iOwn && (
          <>
            {!showForward ? (
              <button className="btn btn-small" onClick={() => setShowForward(true)}>
                转交给…
              </button>
            ) : (
              <span className="handoff-forward-row">
                <input
                  className="handoff-input"
                  list={forwardListId}
                  placeholder="转交给审校人…"
                  aria-label={`转交 ${c.key} 的审校人`}
                  value={forwardTo}
                  onChange={(e) => setForwardTo(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitForward()}
                />
                <datalist id={forwardListId}>
                  {reviewers.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
                <button className="btn btn-small btn-primary" onClick={submitForward} disabled={!forwardTo.trim()}>
                  确认转交
                </button>
                <button className="btn btn-small" onClick={() => setShowForward(false)}>
                  取消
                </button>
              </span>
            )}
            <button className="btn btn-small" onClick={onReturn}>
              退回
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SideOption({
  side,
  conflict,
  disabled,
  onChoose,
}: {
  side: Side;
  conflict: Conflict;
  disabled: boolean;
  onChoose: () => void;
}) {
  const text = side === 'brand' ? conflict.brandText : conflict.legalText;
  const anchor = side === 'brand' ? conflict.brandAnchor : conflict.legalAnchor;
  const label = SIDE_FULL_LABEL[side];
  return (
    <div className={`option option-${side}`}>
      <div className="option-head">
        <span className="option-label">{label}</span>
        {anchor !== null && (
          <span className="badge badge-moved">
            <i>⇄</i>
            {anchorLabel(anchor)}
          </span>
        )}
        {text === null && (
          <span className="badge badge-deleted">
            <i>✕</i>此侧删除了该段
          </span>
        )}
      </div>
      {text === null ? (
        <p className="option-text option-deleted">
          <del>{conflict.baseText}</del>
        </p>
      ) : (
        <p className="option-text">
          <DiffText parts={diffTokens(conflict.baseText, text)} />
        </p>
      )}
      <button className={`btn btn-${side}`} onClick={onChoose} disabled={disabled}>
        采用{label}
        {text === null ? '（删除此段）' : ''}
      </button>
    </div>
  );
}

/** 冲突卡片：并列展示各方版本与底稿的词级差异，支持四种裁决方式与审校交接。 */
export function ConflictCard({
  conflict: c,
  block,
  resolution,
  handoff,
  underReview,
  active,
  highlighted,
  identity,
  now,
  reviewers,
  onResolve,
  onUnresolve,
  onAssign,
  onClaim,
  onReturn,
  onForward,
  onConfirmReview,
}: ConflictCardProps) {
  const [manual, setManual] = useState('');
  const resolved = resolution !== undefined;

  // 交接进行中且持有者不是自己 → 本卡片只读（只锁定这一处冲突）
  const lockedByOther =
    !underReview &&
    !!handoff &&
    (handoff.status === 'assigned' || handoff.status === 'claimed') &&
    handoff.owner !== null &&
    handoff.owner !== identity;
  const decisionDisabled = lockedByOther;

  const chosenText = resolved
    ? resolution.choice === 'brand'
      ? c.brandText
      : resolution.choice === 'legal'
        ? c.legalText
        : resolution.choice === 'base'
          ? c.baseText
          : (resolution.manualText ?? '')
    : null;

  const badgeClass = underReview
    ? 'badge-review'
    : resolved
      ? 'badge-resolved'
      : 'badge-pending';
  const badgeText = underReview
    ? '待复核'
    : resolved
      ? `已解决 · ${CHOICE_LABEL[resolution.choice]}`
      : '待解决';

  return (
    <div
      id={`conflict-${c.id}`}
      className={`conflict-card ${resolved && !underReview ? 'is-resolved' : 'is-pending'} ${
        underReview ? 'is-review' : ''
      } ${active ? 'is-active' : ''} ${highlighted ? 'highlighted' : ''} ${
        lockedByOther ? 'is-locked' : ''
      }`}
      data-base-idx={c.baseIdx}
      data-conflict-key={c.key}
    >
      <div className="conflict-header">
        <span className="conflict-status-icon" aria-hidden>
          {underReview ? '↻' : resolved ? '✓' : '⚠'}
        </span>
        <span className="conflict-title">
          底稿 第{c.baseIdx + 1}段 · {CONFLICT_TYPE_LABEL[c.type]}
        </span>
        <span className={`badge ${badgeClass}`}>{badgeText}</span>
      </div>

      <HandoffBar
        c={c}
        handoff={handoff}
        identity={identity}
        now={now}
        reviewers={reviewers}
        lockedByOther={lockedByOther}
        onAssign={(to) => onAssign(c.key, to)}
        onClaim={() => onClaim(c.key)}
        onReturn={() => onReturn(c.key)}
        onForward={(to) => onForward(c.key, to)}
      />

      {underReview && (
        <div className="review-banner" role="alert">
          <span>
            ↻ 来源文稿已更新，此冲突内容发生变化。{resolved ? '原裁决保留备查但暂不生效' : '原审校交接已暂停'}，请重新确认。
          </span>
          <div className="review-actions">
            {resolved && (
              <button className="btn btn-small btn-primary" onClick={() => onConfirmReview(c.key)}>
                沿用原决定（{CHOICE_LABEL[resolution.choice]}）
              </button>
            )}
            {!resolved && (
              <button className="btn btn-small btn-primary" onClick={() => onConfirmReview(c.key)}>
                恢复交接，继续处理
              </button>
            )}
          </div>
        </div>
      )}

      {!resolved || underReview ? (
        <div className="conflict-body">
          <div className="option-grid">
            <SideOption side="brand" conflict={c} disabled={decisionDisabled} onChoose={() => onResolve(c.key, 'brand')} />
            <SideOption side="legal" conflict={c} disabled={decisionDisabled} onChoose={() => onResolve(c.key, 'legal')} />
            <div className="option option-base">
              <div className="option-head">
                <span className="option-label">底稿原文</span>
              </div>
              <p className="option-text">{c.baseText}</p>
              <button className="btn" onClick={() => onResolve(c.key, 'base')} disabled={decisionDisabled}>
                保留底稿
              </button>
            </div>
          </div>
          <div className="manual-row">
            <textarea
              placeholder="都不满意？在此手动填写该段的最终文本…"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              rows={3}
              aria-label="手动填写合并结果"
              disabled={decisionDisabled}
            />
            <button
              className="btn"
              disabled={manual.trim() === '' || decisionDisabled}
              onClick={() => {
                onResolve(c.key, 'manual', manual.trim());
                setManual('');
              }}
            >
              使用手动文本
            </button>
          </div>
        </div>
      ) : (
        <div className="conflict-body">
          {chosenText === null ? (
            <p className="resolved-note">
              <span className="badge badge-deleted">
                <i>✕</i>该段已按{SIDE_FULL_LABEL[resolution.choice as Side] ?? ''}意见删除
              </span>
            </p>
          ) : (
            <p className="card-text">
              {resolution.choice === 'base' ? (
                c.baseText
              ) : (
                <DiffText parts={diffTokens(c.baseText, chosenText ?? '')} />
              )}
            </p>
          )}
          {block.moved && (
            <div className="card-meta">
              <span className="badge badge-moved">
                <i>⇄</i>第{block.moved.fromBaseIdx + 1}段 → {anchorLabel(block.moved.anchorBaseIdx)}
              </span>
            </div>
          )}
          <div className="resolved-actions">
            <button className="btn" onClick={() => onUnresolve(c.key)}>
              重新打开
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
