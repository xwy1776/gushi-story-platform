import prisma from '@/lib/prisma';

export async function getOrderedChain(storyId: string, branchId: string) {
  const segments = await prisma.storySegment.findMany({
    where: { storyId, branchId },
    orderBy: { createdAt: 'asc' },
  });

  if (branchId === 'main') {
    const chain: typeof segments = [];
    let current = segments.find((s) => !s.parentSegmentId);
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      chain.push(current);
      current = segments.find((s) => s.parentSegmentId === current!.id);
    }
    return chain;
  } else {
    const branch = await prisma.storyBranch.findUnique({ where: { id: branchId } });
    if (!branch) return [];

    const mainSegs = await prisma.storySegment.findMany({
      where: { storyId, branchId: 'main' },
      orderBy: { createdAt: 'asc' },
    });

    const chain: typeof segments = [];
    let current = mainSegs.find((s) => !s.parentSegmentId);
    const visitedMain = new Set<string>();
    while (current && !visitedMain.has(current.id)) {
      visitedMain.add(current.id);
      chain.push(current);
      if (current.id === branch.sourceSegmentId) break;
      current = mainSegs.find((s) => s.parentSegmentId === current!.id);
    }

    let branchCurrent = segments.find((s) => s.parentSegmentId === branch.sourceSegmentId);
    const visitedBranch = new Set<string>();
    while (branchCurrent && !visitedBranch.has(branchCurrent.id)) {
      visitedBranch.add(branchCurrent.id);
      chain.push(branchCurrent);
      branchCurrent = segments.find((s) => s.parentSegmentId === branchCurrent!.id);
    }
    return chain;
  }
}

/**
 * 定位目标段在链中的上下文位置（供生图端使用）。
 *
 * 背景（C4-② 图文对齐）：此前生图端用 `chain.slice(-6, -1)` 取"上下文窗口"，
 * 实际取的是**链路末端**的段落——只有当目标段恰好是末段时才正确；对历史段落
 * 重新生成图片时，喂给模型的"上文"是故事结尾附近的剧情，导致图文不符。
 * 本函数按**目标段**对齐窗口。
 *
 * - `isLatest`：目标段是否为分支末段（决定滚动场景状态是否适用）
 * - `preceding`：目标段之前的最多 count 个段落（按链序）
 * - 目标段不在链中时：`isLatest = true`（无法判断时保持旧行为，由调用方继续）
 */
export function locateSegmentContext<T extends { id: string }>(
  chain: T[],
  targetSegmentId: string,
  count = 5,
): { isLatest: boolean; targetIdx: number; preceding: T[] } {
  const targetIdx = chain.findIndex(s => s.id === targetSegmentId);
  if (targetIdx < 0) {
    return { isLatest: true, targetIdx: -1, preceding: [] };
  }
  return {
    isLatest: targetIdx === chain.length - 1,
    targetIdx,
    preceding: chain.slice(Math.max(0, targetIdx - count), targetIdx),
  };
}
