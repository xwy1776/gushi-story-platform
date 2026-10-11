/**
 * C1: 场景状态新鲜度判据的单元测试
 *
 * 覆盖 director-manager.ts 导出的纯函数 isSceneStateFreshFor：
 *  - 状态由目标段 / 更靠后段落更新 → fresh
 *  - 状态落后于目标段 → stale（生图端应等待追平）
 *  - 缺标记 / 任一段不在链中 → unknown
 *
 * 运行：npx vitest run tests/director-scene-state.test.ts
 */
import { describe, it, expect } from 'vitest';
import { isSceneStateFreshFor } from '@/lib/director-manager';

const CHAIN = [{ id: 'seg_1' }, { id: 'seg_2' }, { id: 'seg_3' }];

describe('isSceneStateFreshFor（C1 场景状态新鲜度）', () => {
  it('状态由目标段更新而来 → fresh（零等待）', () => {
    expect(isSceneStateFreshFor('seg_2', 'seg_2', CHAIN)).toBe('fresh');
  });

  it('状态由更靠后的段落更新而来 → fresh（生成历史段落图时不等待）', () => {
    expect(isSceneStateFreshFor('seg_3', 'seg_1', CHAIN)).toBe('fresh');
    expect(isSceneStateFreshFor('seg_2', 'seg_1', CHAIN)).toBe('fresh');
  });

  it('状态落后于目标段 → stale（生图端应等待追平）', () => {
    expect(isSceneStateFreshFor('seg_1', 'seg_2', CHAIN)).toBe('stale');
    expect(isSceneStateFreshFor('seg_1', 'seg_3', CHAIN)).toBe('stale');
    expect(isSceneStateFreshFor('seg_2', 'seg_3', CHAIN)).toBe('stale');
  });

  it('缺少 lastSegmentId（null/undefined/空串）→ unknown', () => {
    expect(isSceneStateFreshFor(undefined, 'seg_2', CHAIN)).toBe('unknown');
    expect(isSceneStateFreshFor('', 'seg_2', CHAIN)).toBe('unknown');
  });

  it('目标段不在链中 → unknown（不等待，直接读取）', () => {
    expect(isSceneStateFreshFor('seg_2', 'seg_ghost', CHAIN)).toBe('unknown');
  });

  it('状态标记的段落不在链中 → unknown（数据异常，不无限等待）', () => {
    expect(isSceneStateFreshFor('seg_ghost', 'seg_2', CHAIN)).toBe('unknown');
  });

  it('空链 → unknown', () => {
    expect(isSceneStateFreshFor('seg_1', 'seg_1' as string, [])).toBe('fresh'); // 同段直接命中，无需链
    expect(isSceneStateFreshFor('seg_2', 'seg_1', [])).toBe('unknown');
  });
});
