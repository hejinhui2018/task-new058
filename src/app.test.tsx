import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { SAMPLE_BRAND } from './sample';

beforeEach(() => {
  localStorage.clear();
});

/** 按冲突 id 定位卡片（示例稿件：c4 = 第5段双方修改，c6 = 第7段删除 vs 修改） */
function conflictCard(id: string) {
  const el = document.getElementById(`conflict-${id}`);
  if (!el) throw new Error(`找不到冲突卡片 ${id}`);
  return within(el as HTMLElement);
}

/** 卡片完整文本（跨子元素匹配，如"已交给 小王 审校"被 <b> 拆开的情况） */
function cardText(id: string): string {
  const el = document.getElementById(`conflict-${id}`);
  if (!el) throw new Error(`找不到冲突卡片 ${id}`);
  return el.textContent ?? '';
}

/** 通过界面把冲突交给审校人；ttlValue 为下拉框的毫秒值（默认 1 天） */
function claimViaUI(id: string, segLabel: string, reviewer: string, ttlValue?: string) {
  const card = conflictCard(id);
  if (ttlValue !== undefined) {
    fireEvent.change(card.getByLabelText(`审校时限（${segLabel}）`), { target: { value: ttlValue } });
  }
  fireEvent.change(card.getByLabelText(`审校人姓名（${segLabel}）`), { target: { value: reviewer } });
  fireEvent.click(card.getByRole('button', { name: '交给审校' }));
}

/** 编辑品牌版原稿：改写第 5 段行长引言（c4 对应内容），其余段落不动 */
function editBrandParagraph5() {
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
  fireEvent.change(screen.getByLabelText('编辑品牌版'), {
    target: {
      value: SAMPLE_BRAND.replace('金融服务智能化升级的重要里程碑', '金融服务智能化升级的关键一步'),
    },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存并重算' }));
}

describe('工作台界面', () => {
  it('加载内置示例并显示两个待解决冲突', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '联合改稿工作台' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '共同底稿' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '品牌版' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '法务版' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '合并结果' })).toBeTruthy();
    expect(screen.getByTestId('stat-pending').textContent).toContain('2');
    expect(screen.getByTestId('stat-moved').textContent).toContain('1');
    expect(screen.getByTestId('stat-inserted').textContent).toContain('2');
  });

  it('选择一侧解决冲突后，状态变为已解决', () => {
    render(<App />);
    const buttons = screen.getAllByRole('button', { name: '采用法务版' });
    fireEvent.click(buttons[0]);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    expect(screen.getByTestId('stat-pending').textContent).toContain('1');
    expect(screen.getAllByText(/已解决 · 采用法务版/).length).toBeGreaterThan(0);
  });

  it('撤销可以回退裁决，重做可以恢复', () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: '采用品牌版' })[0]);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');

    fireEvent.click(screen.getByRole('button', { name: /撤销/ }));
    expect(screen.getByTestId('stat-resolved').textContent).toContain('0');
    expect(screen.getByTestId('stat-pending').textContent).toContain('2');

    fireEvent.click(screen.getByRole('button', { name: /重做/ }));
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
  });

  it('手动填写可以解决冲突', () => {
    render(<App />);
    const textarea = screen.getAllByLabelText('手动填写合并结果')[0];
    fireEvent.change(textarea, { target: { value: '人工定稿的最终表述。' } });
    fireEvent.click(screen.getAllByRole('button', { name: '使用手动文本' })[0]);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    // 手动文本以差异高亮形式出现在已解决卡片中
    expect(screen.getByText('人工定稿')).toBeTruthy();
  });

  it('重新打开让冲突回到待解决', () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: '保留底稿' })[0]);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    expect(screen.getByTestId('stat-pending').textContent).toContain('2');
  });

  it('一键恢复示例会清空全部裁决', () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: '采用品牌版' })[0]);
    // 第一个冲突解决后其按钮消失，重新查询剩余的"采用法务版"按钮
    fireEvent.click(screen.getAllByRole('button', { name: '采用法务版' })[0]);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('2');

    fireEvent.click(screen.getByRole('button', { name: /恢复示例/ }));
    expect(screen.getByTestId('stat-pending').textContent).toContain('2');
    expect(screen.getByTestId('stat-resolved').textContent).toContain('0');
  });

  it('状态持久化到 localStorage', () => {
    const { unmount } = render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: '采用品牌版' })[0]);
    unmount();

    render(<App />);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
  });
});

describe('审校交接', () => {
  it('交接只锁定对应冲突，其余冲突仍可裁决（多冲突并行）', () => {
    render(<App />);
    claimViaUI('c4', '第5段', '小王');

    // c4 锁定：裁决按钮消失，显示审校中
    const card4 = conflictCard('c4');
    expect(card4.queryByRole('button', { name: '采用法务版' })).toBeNull();
    expect(cardText('c4')).toContain('已交给 小王 审校');
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');

    // c6 不受影响，可正常裁决
    fireEvent.click(conflictCard('c6').getByRole('button', { name: '采用法务版' }));
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    // c4 仍然锁定
    expect(conflictCard('c4').queryByRole('button', { name: '采用法务版' })).toBeNull();
  });

  it('退回后冲突恢复可直接裁决', () => {
    render(<App />);
    claimViaUI('c4', '第5段', '小王');
    fireEvent.click(conflictCard('c4').getByRole('button', { name: '退回' }));

    expect(conflictCard('c4').getByRole('button', { name: '采用法务版' })).toBeTruthy();
    expect(screen.queryByTestId('stat-handoff')).toBeNull();
  });

  it('转交给其他审校人', () => {
    render(<App />);
    claimViaUI('c4', '第5段', '小王');
    fireEvent.click(conflictCard('c4').getByRole('button', { name: '转交' }));

    const card = conflictCard('c4');
    fireEvent.change(card.getByLabelText('审校人姓名（第5段）'), { target: { value: '小李' } });
    fireEvent.click(card.getByRole('button', { name: '确认转交' }));

    expect(cardText('c4')).toContain('已交给 小李 审校');
    expect(conflictCard('c4').queryByRole('button', { name: '采用法务版' })).toBeNull();
  });

  it('交接超时后自动解除锁定', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      claimViaUI('c4', '第5段', '小王', '3600000'); // 1 小时
      expect(conflictCard('c4').queryByRole('button', { name: '采用法务版' })).toBeNull();

      // 推进超过时限并触发刷新节拍
      act(() => {
        vi.advanceTimersByTime(3_600_000 + 31_000);
      });

      expect(cardText('c4')).toContain('审校已超时');
      expect(conflictCard('c4').getByRole('button', { name: '采用法务版' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('交接状态刷新后恢复（localStorage 持久化）', () => {
    const { unmount } = render(<App />);
    claimViaUI('c4', '第5段', '小王');
    unmount();

    render(<App />);
    expect(cardText('c4')).toContain('已交给 小王 审校');
    expect(conflictCard('c4').queryByRole('button', { name: '采用法务版' })).toBeNull();
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
  });

  it('来源文稿变化后，受影响交接变为待复核，未受影响交接保留', () => {
    render(<App />);
    claimViaUI('c4', '第5段', '小王');
    claimViaUI('c6', '第7段', '小李');

    editBrandParagraph5();

    // c4 对应内容变了 → 待复核（仍锁定）
    const card4 = conflictCard('c4');
    expect(cardText('c4')).toContain('来源文稿已变化');
    expect(card4.queryByRole('button', { name: '采用法务版' })).toBeNull();
    // c6 未受影响 → 仍审校中
    expect(cardText('c6')).toContain('已交给 小李 审校');
    expect(conflictCard('c6').queryByRole('button', { name: '采用法务版' })).toBeNull();
    expect(screen.getByTestId('stat-handoff').textContent).toContain('2');

    // 确认复核后 c4 恢复审校中
    fireEvent.click(card4.getByRole('button', { name: '确认复核并继续' }));
    expect(cardText('c4')).toContain('已交给 小王 审校');
  });

  it('来源文稿变化后，未受影响的裁决保留', () => {
    render(<App />);
    fireEvent.click(conflictCard('c6').getByRole('button', { name: '采用法务版' }));
    claimViaUI('c4', '第5段', '小王');
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');

    editBrandParagraph5();

    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    expect(conflictCard('c6').getByText(/已解决 · 采用法务版/)).toBeTruthy();
    expect(cardText('c4')).toContain('来源文稿已变化');
  });

  it('交接操作进入撤销/重做历史', () => {
    render(<App />);
    claimViaUI('c4', '第5段', '小王');
    expect(conflictCard('c4').queryByRole('button', { name: '采用法务版' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /撤销/ }));
    expect(conflictCard('c4').getByRole('button', { name: '采用法务版' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重做/ }));
    expect(conflictCard('c4').queryByRole('button', { name: '采用法务版' })).toBeNull();
  });

  it('重复提交裁决只产生一条历史记录', () => {
    render(<App />);
    fireEvent.click(conflictCard('c4').getByRole('button', { name: '采用法务版' }));
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');

    // 一次撤销即回到全部待解决：双击/重放不会叠加历史
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }));
    expect(screen.getByTestId('stat-resolved').textContent).toContain('0');
    expect(screen.getByTestId('stat-pending').textContent).toContain('2');
  });

  it('恢复示例会清空交接', () => {
    render(<App />);
    claimViaUI('c4', '第5段', '小王');
    fireEvent.click(screen.getByRole('button', { name: /恢复示例/ }));

    expect(conflictCard('c4').getByRole('button', { name: '采用法务版' })).toBeTruthy();
    expect(screen.queryByTestId('stat-handoff')).toBeNull();
  });
});
