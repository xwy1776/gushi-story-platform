/**
 * C4-② 图文对齐工具单测
 *
 * 覆盖：
 *  - locateSegmentContext：上下文窗口按目标段对齐（历史段落不再错用"链路末端"窗口）
 *  - sampleSegmentText：超长段落头+尾采样（段尾关键画面不丢）
 *
 * 运行：npx vitest run tests/context-window.test.ts
 */
import { describe, it, expect } from 'vitest';
import { locateSegmentContext } from '@/lib/chain-helpers';
import { sampleSegmentText } from '@/lib/text-window';

describe('locateSegmentContext', () => {
  const chain = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }];

  it('目标为末段：isLatest=true，窗口为其前 5 段', () => {
    const r = locateSegmentContext(chain, 'g', 5);
    expect(r.isLatest).toBe(true);
    expect(r.targetIdx).toBe(6);
    expect(r.preceding.map(s => s.id)).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('目标为历史段落：窗口按目标段对齐（不是链路末端）', () => {
    const r = locateSegmentContext(chain, 'c', 5);
    expect(r.isLatest).toBe(false);
    expect(r.targetIdx).toBe(2);
    expect(r.preceding.map(s => s.id)).toEqual(['a', 'b']);
  });

  it('首段：preceding 为空', () => {
    const r = locateSegmentContext(chain, 'a', 5);
    expect(r.isLatest).toBe(false);
    expect(r.preceding).toEqual([]);
  });

  it('窗口大小受 count 限制', () => {
    const r = locateSegmentContext(chain, 'f', 2);
    expect(r.preceding.map(s => s.id)).toEqual(['d', 'e']);
  });

  it('目标段不在链中：isLatest=true（无法判断时保持旧行为），preceding 为空', () => {
    const r = locateSegmentContext(chain, 'zzz', 5);
    expect(r.isLatest).toBe(true);
    expect(r.targetIdx).toBe(-1);
    expect(r.preceding).toEqual([]);
  });

  it('单段链：该段即末段', () => {
    const r = locateSegmentContext([{ id: 'only' }], 'only');
    expect(r.isLatest).toBe(true);
    expect(r.preceding).toEqual([]);
  });
});

describe('sampleSegmentText', () => {
  it('不超限：原样返回', () => {
    const text = '短段落。'.repeat(10);
    expect(sampleSegmentText(text, 1500)).toBe(text);
  });

  it('超限：保留头部与尾部（段尾关键画面不丢）', () => {
    const head = 'H'.repeat(1000);
    const middle = 'M'.repeat(3000);
    const tail = 'T'.repeat(400);
    const out = sampleSegmentText(head + middle + tail, 1500);
    expect(out.length).toBeLessThanOrEqual(1520); // 含省略标记的小幅余量
    expect(out.startsWith('H'.repeat(200))).toBe(true);
    expect(out).toContain('……（中间省略）……');
    expect(out.endsWith('T'.repeat(400))).toBe(true);
  });

  it('边界：恰好等于上限原样返回', () => {
    const text = 'x'.repeat(1500);
    expect(sampleSegmentText(text, 1500)).toBe(text);
  });

  it('空字符串 / 非字符串安全返回空串', () => {
    expect(sampleSegmentText('')).toBe('');
    expect(sampleSegmentText(null as unknown as string)).toBe('');
    expect(sampleSegmentText(undefined as unknown as string)).toBe('');
  });

  it('自定义上限：尾部始终保留（400 或上限的 1/3 取小）', () => {
    const text = 'A'.repeat(500) + 'B'.repeat(500);
    const out = sampleSegmentText(text, 300);
    expect(out.endsWith('B'.repeat(100))).toBe(true); // tailChars = min(400, 100) = 100
    expect(out).toContain('……（中间省略）……');
  });
});
