import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  localStorage.clear();
});

function getPane(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('section')!;
}

function switchIdentity(name: string) {
  fireEvent.change(screen.getByLabelText('当前身份'), { target: { value: name } });
}

function assignFirstConflict(reviewer: string) {
  const inputs = screen.getAllByPlaceholderText('指派给审校人…');
  fireEvent.change(inputs[0], { target: { value: reviewer } });
  // 每个卡片有自己的"指派"按钮，取第一个冲突卡片内的
  const cards = document.querySelectorAll('[data-conflict-key]');
  fireEvent.click(within(cards[0] as HTMLElement).getAllByRole('button', { name: '指派' })[0]);
}

describe('审校交接：多冲突并行', () => {
  it('指派并领取后只锁定对应冲突，其他冲突仍可处理', () => {
    render(<App />);
    // 编辑甲把第一个冲突指派给小林
    assignFirstConflict('审校小林');
    // 小林领取
    switchIdentity('审校小林');
    fireEvent.click(screen.getByRole('button', { name: '开始处理' }));
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');

    // 老周视角：第一个冲突被锁定，提交按钮禁用；第二个冲突可以正常处理
    switchIdentity('审校老周');
    const cards = document.querySelectorAll('[data-conflict-key]');
    expect(cards[0].className).toContain('is-locked');
    expect(within(cards[0] as HTMLElement).getByText(/已锁定给/)).toBeTruthy();
    const lockedBrand = within(cards[0] as HTMLElement).getByRole('button', { name: '采用品牌版' });
    expect(lockedBrand.hasAttribute('disabled')).toBe(true);

    const secondLegal = within(cards[1] as HTMLElement).getByRole('button', { name: '采用法务版' });
    expect(secondLegal.hasAttribute('disabled')).toBe(false);
    fireEvent.click(secondLegal);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    // 第一个仍处于交接中
    expect(screen.getByTestId('stat-pending').textContent).toContain('1');
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
  });

  it('领取后可退回，锁立即释放', () => {
    render(<App />);
    assignFirstConflict('审校小林');
    switchIdentity('审校小林');
    fireEvent.click(screen.getByRole('button', { name: '开始处理' }));
    fireEvent.click(screen.getByRole('button', { name: '退回' }));
    expect(screen.getByTestId('stat-handoff').textContent).toContain('0');
    // 侧栏显示已退回
    expect(screen.getAllByText('已退回').length).toBeGreaterThan(0);
    // 老周可以领取
    switchIdentity('审校老周');
    const cards = document.querySelectorAll('[data-conflict-key]');
    fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: '我来处理' }));
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
  });

  it('转交后锁转移到新审校人，倒计时重新开始', () => {
    render(<App />);
    switchIdentity('审校小林');
    const cards0 = () => document.querySelectorAll('[data-conflict-key]')[0] as HTMLElement;
    fireEvent.click(within(cards0()).getByRole('button', { name: '我来处理' }));
    expect(within(cards0()).getByTestId(/timer-/)).toBeTruthy();

    fireEvent.click(within(cards0()).getByRole('button', { name: '转交给…' }));
    const forwardInput = within(cards0()).getAllByPlaceholderText('转交给审校人…')[0];
    fireEvent.change(forwardInput, { target: { value: '审校老周' } });
    fireEvent.click(within(cards0()).getByRole('button', { name: '确认转交' }));

    // 小林已失去该冲突
    expect(within(cards0()).getByText(/已锁定给 审校老周/)).toBeTruthy();
    // 老周视角是自己的处理中任务
    switchIdentity('审校老周');
    expect(screen.getAllByText('你处理中').length).toBeGreaterThan(0);
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
  });

  it('超时后状态变为已超时，锁释放可再领取', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      switchIdentity('审校小林');
      const cards0 = () => document.querySelectorAll('[data-conflict-key]')[0] as HTMLElement;
      fireEvent.click(within(cards0()).getByRole('button', { name: '我来处理' }));
      // 超过 30 分钟默认处理时限
      act(() => {
        vi.advanceTimersByTime(31 * 60 * 1000);
      });
      expect(screen.getAllByText('已超时').length).toBeGreaterThan(0);
      expect(screen.getByTestId('stat-handoff').textContent).toContain('0');
      // 老周可以接手
      switchIdentity('审校老周');
      fireEvent.click(within(cards0()).getByRole('button', { name: '我来处理' }));
      expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('来源文稿更新后的待复核', () => {
  it('影响到的裁决转待复核并在导出中标记，未受影响的裁决保留', () => {
    render(<App />);
    // 两个冲突都先解决（第二张卡是删除 vs 修改冲突，品牌侧按钮名为"采用品牌版（删除此段）"）
    fireEvent.click(screen.getAllByRole('button', { name: '采用法务版' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '采用法务版' })[0]);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('2');

    // 编辑品牌版，只改写第一个冲突（行长引言）对应的品牌段落
    const brandPane = getPane('品牌版');
    fireEvent.click(within(brandPane).getByRole('button', { name: '编辑' }));
    const editor = screen.getByLabelText('编辑品牌版') as HTMLTextAreaElement;
    const updated = editor.value.replace('全新标杆', '全新标杆（品牌二次修订）');
    expect(updated).not.toBe(editor.value);
    fireEvent.change(editor, { target: { value: updated } });
    fireEvent.click(screen.getByRole('button', { name: '保存并重算' }));

    // 一个待复核，另一个裁决原样保留
    expect(screen.getByTestId('stat-review').textContent).toContain('1');
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    expect(screen.getByTestId('stat-pending').textContent).toContain('1');
    expect(screen.getByText(/来源文稿已更新/)).toBeTruthy();
    // 复核横幅提供"沿用原决定"
    expect(screen.getByRole('button', { name: '沿用原决定（采用法务版）' })).toBeTruthy();

    // 复核通过后恢复已解决
    fireEvent.click(screen.getByRole('button', { name: '沿用原决定（采用法务版）' }));
    expect(screen.getByTestId('stat-resolved').textContent).toContain('2');
    expect(screen.queryByTestId('stat-review')).toBeNull();
  });

  it('交接中的冲突在来源变化后挂起，确认后可继续处理', () => {
    render(<App />);
    switchIdentity('审校小林');
    const cards0 = () => document.querySelectorAll('[data-conflict-key]')[0] as HTMLElement;
    fireEvent.click(within(cards0()).getByRole('button', { name: '我来处理' }));
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');

    // 编辑甲更新品牌版中该冲突段落
    switchIdentity('编辑甲');
    const brandPane = getPane('品牌版');
    fireEvent.click(within(brandPane).getByRole('button', { name: '编辑' }));
    const editor = screen.getByLabelText('编辑品牌版') as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: { value: editor.value.replace('全新标杆', '全新标杆（措辞调整）') },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并重算' }));

    expect(screen.getByTestId('stat-review').textContent).toContain('1');
    // 锁已挂起
    expect(screen.getByTestId('stat-handoff').textContent).toContain('0');
    expect(screen.getByText(/原审校交接已暂停/)).toBeTruthy();

    // 小林确认后恢复交接
    switchIdentity('审校小林');
    fireEvent.click(screen.getByRole('button', { name: '恢复交接，继续处理' }));
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
    expect(screen.queryByTestId('stat-review')).toBeNull();
    // 可以正常提交裁决
    fireEvent.click(within(cards0()).getAllByRole('button', { name: '采用法务版' })[0]);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
  });
});

describe('刷新恢复', () => {
  it('刷新后交接锁定与裁决按冲突身份恢复', () => {
    const { unmount } = render(<App />);
    switchIdentity('审校小林');
    const cards0 = () => document.querySelectorAll('[data-conflict-key]')[0] as HTMLElement;
    fireEvent.click(within(cards0()).getByRole('button', { name: '我来处理' }));
    // 第二个冲突由小林直接裁决（锁定只影响第一个）
    fireEvent.click(
      within(document.querySelectorAll('[data-conflict-key]')[1] as HTMLElement).getByRole('button', {
        name: '采用法务版',
      }),
    );
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    unmount();

    // 切到老周身份后刷新：第一个冲突仍锁定给小林
    render(<App />);
    switchIdentity('审校老周');
    const cards = document.querySelectorAll('[data-conflict-key]');
    expect(cards[0].className).toContain('is-locked');
    expect(within(cards[0] as HTMLElement).getByText(/已锁定给 审校小林/)).toBeTruthy();
    // 第二个冲突的裁决还在
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
  });
});

describe('撤销重做覆盖交接', () => {
  it('领取可撤销可重做；提交裁决后撤销会恢复处理中锁定', () => {
    render(<App />);
    switchIdentity('审校小林');
    const cards0 = () => document.querySelectorAll('[data-conflict-key]')[0] as HTMLElement;
    fireEvent.click(within(cards0()).getByRole('button', { name: '我来处理' }));
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');

    fireEvent.click(screen.getByRole('button', { name: /撤销/ }));
    expect(screen.getByTestId('stat-handoff').textContent).toContain('0');
    fireEvent.click(screen.getByRole('button', { name: /重做/ }));
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');

    // 处理中提交裁决，再撤销：回到处理中而不是裸待解决
    fireEvent.click(within(cards0()).getAllByRole('button', { name: '采用法务版' })[0]);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
    expect(screen.getByTestId('stat-handoff').textContent).toContain('0');
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }));
    expect(screen.getByTestId('stat-resolved').textContent).toContain('0');
    expect(screen.getByTestId('stat-handoff').textContent).toContain('1');
  });
});

describe('重复提交防护', () => {
  it('锁定冲突的提交按钮不可用；未锁定冲突快速双击只产生一次裁决', () => {
    render(<App />);
    switchIdentity('审校小林');
    const cards = () => document.querySelectorAll('[data-conflict-key]');
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: '我来处理' }));
    switchIdentity('审校老周');
    // 小林处理中的冲突：老周的提交按钮全部禁用
    const lockedCard = cards()[0] as HTMLElement;
    for (const btn of within(lockedCard).getAllByRole('button')) {
      if (/采用|保留底稿|使用手动文本/.test(btn.textContent ?? '')) {
        expect(btn.hasAttribute('disabled')).toBe(true);
      }
    }

    // 老周在自己可处理的第二个冲突上快速双击，只计一次裁决
    switchIdentity('编辑甲');
    const target = within(cards()[1] as HTMLElement).getByRole('button', { name: '采用法务版' });
    fireEvent.click(target);
    // 同一节点再派发一次点击（模拟重复提交）
    fireEvent.click(target);
    expect(screen.getByTestId('stat-resolved').textContent).toContain('1');
  });
});
