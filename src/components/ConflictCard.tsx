import { useState } from 'react';
import type { Conflict, MergedBlock, Resolution, Side } from '../lib/merge';
import { diffTokens } from '../lib/diff';
import { DiffText } from './DiffText';
import { CHOICE_LABEL, CONFLICT_TYPE_LABEL } from './ConflictSidebar';
import { SIDE_FULL_LABEL } from './Badges';
import {
  DEFAULT_TTL_MS,
  HANDOFF_TTL_OPTIONS,
  handoffStatus,
  isHandoffLocked,
  remainingLabel,
  type Handoff,
} from '../state/handoff';

interface ConflictCardProps {
  conflict: Conflict;
  block: MergedBlock;
  resolution: Resolution | undefined;
  handoff: Handoff | undefined;
  now: number;
  active: boolean;
  highlighted: boolean;
  onResolve: (id: string, choice: 'brand' | 'legal' | 'base' | 'manual', manualText?: string) => void;
  onUnresolve: (id: string) => void;
  onClaim: (id: string, reviewer: string, ttlMs: number) => void;
  onReturn: (id: string) => void;
  onReassign: (id: string, reviewer: string, ttlMs: number) => void;
  onAcknowledge: (id: string) => void;
}

function anchorLabel(anchor: number): string {
  return anchor === -1 ? '移至文首' : `移至第${anchor + 1}段后`;
}

function SideOption({
  side,
  conflict,
  onChoose,
}: {
  side: Side;
  conflict: Conflict;
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
      <button className={`btn btn-${side}`} onClick={onChoose}>
        采用{label}
        {text === null ? '（删除此段）' : ''}
      </button>
    </div>
  );
}

/** 审校人 + 时限选择（领取与转交共用） */
function ReviewerFields({
  idPrefix,
  name,
  ttl,
  onNameChange,
  onTtlChange,
}: {
  idPrefix: string;
  name: string;
  ttl: number;
  onNameChange: (v: string) => void;
  onTtlChange: (v: number) => void;
}) {
  return (
    <>
      <input
        aria-label={`审校人姓名（${idPrefix}）`}
        placeholder="审校人姓名"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
      />
      <select
        aria-label={`审校时限（${idPrefix}）`}
        value={ttl}
        onChange={(e) => onTtlChange(Number(e.target.value))}
      >
        {HANDOFF_TTL_OPTIONS.map((o) => (
          <option key={o.ms} value={o.ms}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );
}

/** 冲突卡片：并列展示各方版本与底稿的词级差异，支持四种裁决方式与按冲突身份的审校交接。 */
export function ConflictCard({
  conflict: c,
  block,
  resolution,
  handoff,
  now,
  active,
  highlighted,
  onResolve,
  onUnresolve,
  onClaim,
  onReturn,
  onReassign,
  onAcknowledge,
}: ConflictCardProps) {
  const [manual, setManual] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [ttl, setTtl] = useState(DEFAULT_TTL_MS);
  const [reassigning, setReassigning] = useState(false);
  const [reassignName, setReassignName] = useState('');
  const [reassignTtl, setReassignTtl] = useState(DEFAULT_TTL_MS);
  const resolved = resolution !== undefined;

  // 交接状态（仅未解决时有意义；裁决落定的同时交接记录会被解除）
  const hStatus = !resolved && handoff ? handoffStatus(handoff, c, now) : null;
  const locked = hStatus !== null && isHandoffLocked(hStatus);
  const segLabel = `第${c.baseIdx + 1}段`;

  const chosenText = resolved
    ? resolution.choice === 'brand'
      ? c.brandText
      : resolution.choice === 'legal'
        ? c.legalText
        : resolution.choice === 'base'
          ? c.baseText
          : (resolution.manualText ?? '')
    : null;

  const headerBadge = resolved ? (
    <span className="badge badge-resolved">已解决 · {CHOICE_LABEL[resolution.choice]}</span>
  ) : hStatus === 'active' ? (
    <span className="badge badge-handoff">审校中 · {handoff!.reviewer}</span>
  ) : hStatus === 'stale' ? (
    <span className="badge badge-stale">待复核 · {handoff!.reviewer}</span>
  ) : hStatus === 'expired' ? (
    <span className="badge badge-expired">审校已超时</span>
  ) : (
    <span className="badge badge-pending">待解决</span>
  );

  const reassignForm = reassigning && (
    <div className="handoff-reassign">
      <ReviewerFields
        idPrefix={segLabel}
        name={reassignName}
        ttl={reassignTtl}
        onNameChange={setReassignName}
        onTtlChange={setReassignTtl}
      />
      <button
        className="btn btn-small"
        disabled={reassignName.trim() === ''}
        onClick={() => {
          onReassign(c.id, reassignName.trim(), reassignTtl);
          setReassigning(false);
        }}
      >
        确认转交
      </button>
      <button className="btn btn-small" onClick={() => setReassigning(false)}>
        取消
      </button>
    </div>
  );

  return (
    <div
      id={`conflict-${c.id}`}
      className={`conflict-card ${resolved ? 'is-resolved' : 'is-pending'} ${locked ? 'is-locked' : ''} ${
        active ? 'is-active' : ''
      } ${highlighted ? 'highlighted' : ''}`}
      data-base-idx={c.baseIdx}
    >
      <div className="conflict-header">
        <span className="conflict-status-icon" aria-hidden>
          {resolved ? '✓' : locked ? '🔒' : '⚠'}
        </span>
        <span className="conflict-title">
          底稿 第{c.baseIdx + 1}段 · {CONFLICT_TYPE_LABEL[c.type]}
        </span>
        {headerBadge}
      </div>

      {resolved ? (
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
            <button className="btn" onClick={() => onUnresolve(c.id)}>
              重新打开
            </button>
          </div>
        </div>
      ) : locked ? (
        <div className="conflict-body">
          {hStatus === 'active' ? (
            <div className="handoff-panel">
              <p className="handoff-note">
                🔒 已交给 <b>{handoff!.reviewer}</b> 审校（{remainingLabel(handoff!, now)}
                ），期间本段不可直接裁决；其余冲突不受影响。
              </p>
              <div className="handoff-actions">
                <button
                  className="btn btn-small"
                  onClick={() => {
                    setReassignName(handoff!.reviewer);
                    setReassignTtl(DEFAULT_TTL_MS);
                    setReassigning(true);
                  }}
                >
                  转交
                </button>
                <button className="btn btn-small" onClick={() => onReturn(c.id)}>
                  退回
                </button>
              </div>
              {reassignForm}
            </div>
          ) : (
            <div className="handoff-panel is-stale">
              <p className="handoff-note">
                ⚠ 来源文稿已变化，本段交接内容需复核（审校人：<b>{handoff!.reviewer}</b>
                ）。确认以当前内容继续审校，或退回后重新指派。
              </p>
              <div className="handoff-actions">
                <button className="btn btn-small" onClick={() => onAcknowledge(c.id)}>
                  确认复核并继续
                </button>
                <button
                  className="btn btn-small"
                  onClick={() => {
                    setReassignName(handoff!.reviewer);
                    setReassignTtl(DEFAULT_TTL_MS);
                    setReassigning(true);
                  }}
                >
                  转交
                </button>
                <button className="btn btn-small" onClick={() => onReturn(c.id)}>
                  退回
                </button>
              </div>
              {reassignForm}
            </div>
          )}
        </div>
      ) : (
        <div className="conflict-body">
          {hStatus === 'expired' && (
            <div className="handoff-panel is-expired">
              <p className="handoff-note">
                ⏰ 审校已超时（审校人：<b>{handoff!.reviewer}</b>
                ），本段已解除锁定，可直接裁决或重新指派。
              </p>
              <div className="handoff-actions">
                <button className="btn btn-small" onClick={() => onReturn(c.id)}>
                  退回交接
                </button>
              </div>
            </div>
          )}
          <div className="option-grid">
            <SideOption side="brand" conflict={c} onChoose={() => onResolve(c.id, 'brand')} />
            <SideOption side="legal" conflict={c} onChoose={() => onResolve(c.id, 'legal')} />
            <div className="option option-base">
              <div className="option-head">
                <span className="option-label">底稿原文</span>
              </div>
              <p className="option-text">{c.baseText}</p>
              <button className="btn" onClick={() => onResolve(c.id, 'base')}>
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
            />
            <button
              className="btn"
              disabled={manual.trim() === ''}
              onClick={() => {
                onResolve(c.id, 'manual', manual.trim());
                setManual('');
              }}
            >
              使用手动文本
            </button>
          </div>
          <div className="handoff-claim">
            <span className="handoff-claim-label">交给审校：</span>
            <ReviewerFields
              idPrefix={segLabel}
              name={reviewer}
              ttl={ttl}
              onNameChange={setReviewer}
              onTtlChange={setTtl}
            />
            <button
              className="btn"
              disabled={reviewer.trim() === ''}
              onClick={() => {
                onClaim(c.id, reviewer.trim(), ttl);
                setReviewer('');
              }}
            >
              交给审校
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
