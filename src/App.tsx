import { useCallback, useEffect, useState } from 'react';
import { useWorkbench, SUGGESTED_REVIEWERS } from './state/useWorkbench';
import { exportMergedText } from './lib/merge';
import { Toolbar } from './components/Toolbar';
import { SummaryBar } from './components/SummaryBar';
import { ConflictSidebar } from './components/ConflictSidebar';
import { SourcePane } from './components/SourcePane';
import { MergedPane } from './components/MergedPane';

export default function App() {
  const wb = useWorkbench();
  const { merge } = wb;
  const [activeConflict, setActiveConflict] = useState(0);
  const [highlightBaseIdx, setHighlightBaseIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const conflicts = merge.conflicts;

  // 冲突数量变化（如编辑原稿后）时校正当前下标
  useEffect(() => {
    if (activeConflict >= conflicts.length) setActiveConflict(0);
  }, [conflicts.length, activeConflict]);

  const jumpToConflict = useCallback(
    (idx: number) => {
      if (conflicts.length === 0) return;
      const i = ((idx % conflicts.length) + conflicts.length) % conflicts.length;
      setActiveConflict(i);
      setHighlightBaseIdx(conflicts[i].baseIdx);
      requestAnimationFrame(() => {
        document
          .getElementById(`conflict-${conflicts[i].id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    },
    [conflicts],
  );

  // Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做（输入框内不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) wb.redo();
        else wb.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        wb.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wb.undo, wb.redo]);

  const handleCopy = useCallback(async () => {
    const text = exportMergedText(merge);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [merge]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([exportMergedText(merge)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '合并稿.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [merge]);

  return (
    <div className="app">
      <Toolbar
        conflictCount={conflicts.length}
        pendingCount={merge.stats.pending}
        activeConflict={activeConflict}
        onPrevConflict={() => jumpToConflict(activeConflict - 1)}
        onNextConflict={() => jumpToConflict(activeConflict + 1)}
        canUndo={wb.canUndo}
        canRedo={wb.canRedo}
        onUndo={wb.undo}
        onRedo={wb.redo}
        onReset={wb.resetSample}
        onCopy={handleCopy}
        onDownload={handleDownload}
        copied={copied}
      />
      <div className="identity-bar">
        <label className="identity-field">
          当前身份：
          <select
            aria-label="当前身份"
            value={SUGGESTED_REVIEWERS.includes(wb.identity) ? wb.identity : '__custom'}
            onChange={(e) => {
              if (e.target.value !== '__custom') wb.setIdentity(e.target.value);
            }}
          >
            {SUGGESTED_REVIEWERS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            {!SUGGESTED_REVIEWERS.includes(wb.identity) && <option value={wb.identity}>{wb.identity}</option>}
            <option value="__custom">自定义…</option>
          </select>
        </label>
        <input
          className="handoff-input identity-input"
          aria-label="自定义身份"
          placeholder="输入你的名字后回车"
          value={SUGGESTED_REVIEWERS.includes(wb.identity) ? '' : wb.identity}
          onChange={(e) => wb.setIdentity(e.target.value)}
        />
        <span className="identity-hint">切换身份可模拟把冲突交给其他审校人；锁定只影响对应冲突。</span>
      </div>
      {wb.actionError && (
        <div className="action-toast" role="alert" data-testid="action-error">
          <span>⚠ {wb.actionError.message}</span>
          <button className="btn btn-small" onClick={wb.clearActionError} aria-label="关闭提示">
            ✕
          </button>
        </div>
      )}
      <SummaryBar stats={merge.stats} handoffs={wb.handoffs} />
      <div className="legend-bar">
        <span>图例：</span>
        <span className="badge badge-modified">
          <i>✎</i>已修改
        </span>
        <span className="badge badge-inserted">
          <i>＋</i>新增
        </span>
        <span className="badge badge-deleted">
          <i>✕</i>已删除
        </span>
        <span className="badge badge-moved">
          <i>⇄</i>移动
        </span>
        <span className="badge badge-review">
          <i>↻</i>待复核
        </span>
        <span>
          <del>删除线</del>＝删去的文字
        </span>
        <span>
          <ins>下划线</ins>＝新增的文字
        </span>
        <span className="legend-tip">点击合并结果中的段落，可在两侧原稿中定位</span>
      </div>
      <div className="main">
        <ConflictSidebar
          conflicts={conflicts}
          resolutions={wb.resolutions}
          handoffs={wb.handoffs}
          reviewKeys={wb.reviewKeys}
          identity={wb.identity}
          activeConflict={activeConflict}
          onJump={jumpToConflict}
        />
        <div className="panes">
          <SourcePane
            title="共同底稿"
            side="base"
            paragraphs={wb.base}
            baseParagraphs={wb.base}
            alignment={null}
            highlightBaseIdx={highlightBaseIdx}
            onSaveText={wb.setBaseText}
          />
          <SourcePane
            title="品牌版"
            side="brand"
            paragraphs={wb.brand}
            baseParagraphs={wb.base}
            alignment={merge.alignments.brand}
            highlightBaseIdx={highlightBaseIdx}
            onSaveText={wb.setBrandText}
          />
          <SourcePane
            title="法务版"
            side="legal"
            paragraphs={wb.legal}
            baseParagraphs={wb.base}
            alignment={merge.alignments.legal}
            highlightBaseIdx={highlightBaseIdx}
            onSaveText={wb.setLegalText}
          />
          <MergedPane
            merge={merge}
            baseParagraphs={wb.base}
            resolutions={wb.resolutions}
            handoffs={wb.handoffs}
            reviewKeys={wb.reviewKeys}
            identity={wb.identity}
            now={wb.now}
            reviewers={SUGGESTED_REVIEWERS}
            highlightBaseIdx={highlightBaseIdx}
            activeConflictId={conflicts[activeConflict]?.id ?? null}
            onResolve={wb.resolve}
            onUnresolve={wb.unresolve}
            onAssign={wb.assign}
            onClaim={wb.claim}
            onReturn={wb.handBack}
            onForward={wb.forward}
            onConfirmReview={wb.confirmAsIs}
            onHighlight={setHighlightBaseIdx}
          />
        </div>
      </div>
    </div>
  );
}
