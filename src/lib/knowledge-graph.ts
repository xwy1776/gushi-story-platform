/**
 * KnowledgeGraph — 知识图谱引擎
 *
 * 对应 DOME (2024.12) 论文的 Memory-Enhancement Module (MEM)。
 *
 * 核心设计：
 * - DOME 把生成过的内容结构化为一张"时序知识图谱"：
 *   节点 = 角色/事件/地点/分支点
 *   边 = 参与/触发/位于/时间先后/分支关联
 * - 每次续写前从图谱中查与当前上下文相关的节点和边，
 *   作为"结构化记忆"注入 Prompt。
 * - 区别于 MemLong 的"原始文本检索"：图谱存的是关系，不是文本片段。
 *
 * Gushi 的增量创新：
 *   因为 Gushi 有多分支叙事，图谱天然带"分支维度"（branchId 标记每条边/节点的分支出处）。
 *   同一个角色在不同分支下可能处于不同状态——DOME 没有这个场景。
 *
 * 与现有模块的关系：
 * - lorebook.ts：现在是扁平字典，被 KnowledgeGraph 替代为图结构存储
 * - character-engine.ts：角色关系图（getRelationshipGraph）可以在图谱中统一管理
 * - consistency-checker.ts：用图谱做"关系约束检查"（ground truth 比对）
 * - narrative-state-tracker.ts：符号化状态表+图谱关系图，两个互补：状态表回答"现在是什么"，
 *   图谱回答"跟什么有关"
 *
 * 数据存储：
 * - 持久化到 data/knowledge-graph.json
 * - 轻量级场景直接读 JSON，大规模故事可迁移到 Neo4j/PostgreSQL
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const GRAPH_FILE = path.join(DATA_DIR, 'knowledge-graph.json');

// ============================================================================
// 类型定义
// ============================================================================

export type NodeType = 'character' | 'event' | 'location' | 'branch_point' | 'faction';

export type EdgeType =
  | 'causes'         // A导致B（因果）
  | 'leads_to'       // A引向B（叙事流程）
  | 'located_at'     // A位于B（空间）
  | 'involves'       // A参与B
  | 'conflicts_with' // A与B冲突
  | 'ally_of'        // A与B结盟
  | 'belongs_to'     // A属于B
  | 'precedes'       // A先于B（时序）
  | 'parallel_to'    // A与B平行（跨分支对应）
  ;

export type KnowledgeNode = {
  id: string;
  type: NodeType;
  name: string;
  branchId: string;                     // 所属分支（跨分支隔离）
  properties: Record<string, string>;   // 灵活属性
  segmentIds: string[];                 // 哪些段落提到了这个节点
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeEdge = {
  id: string;
  source: string;                       // 源节点ID
  target: string;                       // 目标节点ID
  type: EdgeType;
  branchId: string;                     // 建立这个关系的分支
  properties: Record<string, string>;   // 关系的额外描述
  segmentId: string;                    // 在哪一段建立/确认的
  createdAt: string;
};

export type KnowledgeSubgraph = {
  centerNode: KnowledgeNode;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  summary: string;                      // LLM生成的一句话概括
};

// 图谱持久化结构
type GraphData = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  version: number;      // 简易 schema 版本
  updatedAt: string;
};

// ============================================================================
// KnowledgeGraph 类
// ============================================================================

class KnowledgeGraph {
  private data: GraphData | null = null;
  private initialized = false;

  /**
   * 加载图谱数据（懒加载 + 内存缓存）
   */
  private async load(): Promise<GraphData> {
    if (this.initialized && this.data) return this.data;

    try {
      await fs.access(DATA_DIR);
    } catch {
      await fs.mkdir(DATA_DIR, { recursive: true });
    }

    try {
      const raw = await fs.readFile(GRAPH_FILE, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      // 首次使用，初始化为空图谱
      this.data = { nodes: [], edges: [], version: 1, updatedAt: new Date().toISOString() };
      await this.save();
    }

    this.initialized = true;
    return this.data!;
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    this.data.updatedAt = new Date().toISOString();
    await fs.writeFile(GRAPH_FILE, JSON.stringify(this.data, null, 2));
  }

  private genId(): string {
    return `kg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ==========================================================================
  // CRUD: 节点
  // ==========================================================================

  async addNode(params: {
    type: NodeType;
    name: string;
    branchId: string;
    properties?: Record<string, string>;
    segmentId?: string;
  }): Promise<KnowledgeNode> {
    const graph = await this.load();
    const now = new Date().toISOString();

    const node: KnowledgeNode = {
      id: this.genId(),
      type: params.type,
      name: params.name,
      branchId: params.branchId,
      properties: params.properties || {},
      segmentIds: params.segmentId ? [params.segmentId] : [],
      createdAt: now,
      updatedAt: now,
    };

    graph.nodes.push(node);
    await this.save();
    return node;
  }

  /**
   * 获取或创建节点（幂等：按 name+branchId 去重）
   */
  async getOrCreateNode(params: {
    type: NodeType;
    name: string;
    branchId: string;
    properties?: Record<string, string>;
    segmentId?: string;
  }): Promise<KnowledgeNode> {
    const graph = await this.load();
    const existing = graph.nodes.find(n =>
      n.name === params.name && n.type === params.type && n.branchId === params.branchId
    );
    if (existing) {
      // 追加 segmentId
      if (params.segmentId && !existing.segmentIds.includes(params.segmentId)) {
        existing.segmentIds.push(params.segmentId);
        existing.updatedAt = new Date().toISOString();
        await this.save();
      }
      return existing;
    }
    return this.addNode(params);
  }

  async findNodesByType(type: NodeType): Promise<KnowledgeNode[]> {
    const graph = await this.load();
    return graph.nodes.filter(n => n.type === type);
  }

  async findNodeByName(name: string, type?: NodeType): Promise<KnowledgeNode | undefined> {
    const graph = await this.load();
    return graph.nodes.find(n =>
      n.name === name && (type ? n.type === type : true)
    );
  }

  async findNodeById(id: string): Promise<KnowledgeNode | undefined> {
    const graph = await this.load();
    return graph.nodes.find(n => n.id === id);
  }

  // ==========================================================================
  // CRUD: 边
  // ==========================================================================

  async addEdge(params: {
    source: string;
    target: string;
    type: EdgeType;
    branchId: string;
    properties?: Record<string, string>;
    segmentId: string;
  }): Promise<KnowledgeEdge> {
    const graph = await this.load();

    // 验证节点存在
    const srcNode = graph.nodes.find(n => n.id === params.source);
    const tgtNode = graph.nodes.find(n => n.id === params.target);
    if (!srcNode || !tgtNode) {
      throw new Error(`KnowledgeGraph: 边关联的节点不存在 (src=${params.source}, tgt=${params.target})`);
    }

    // 去重：同类型同源同目标的边只保留一条
    const existing = graph.edges.find(e =>
      e.source === params.source && e.target === params.target && e.type === params.type
    );
    if (existing) {
      existing.segmentId = params.segmentId;
      existing.properties = { ...existing.properties, ...params.properties };
      existing.createdAt = new Date().toISOString();
      await this.save();
      return existing;
    }

    const edge: KnowledgeEdge = {
      id: this.genId(),
      source: params.source,
      target: params.target,
      type: params.type,
      branchId: params.branchId,
      properties: params.properties || {},
      segmentId: params.segmentId,
      createdAt: new Date().toISOString(),
    };

    graph.edges.push(edge);
    await this.save();
    return edge;
  }

  // ==========================================================================
  // 核心查询：BFS 邻域查询（DOME MEM 的核心能力）
  // ==========================================================================

  /**
   * 从某个节点出发，N 跳内找到所有关联节点和边。
   *
   * 算法：BFS
   * 复杂度：O(V + E)，实际场景下节点数 <= 200，边数 <= 1000，完全够用。
   */
  async queryNeighborhood(
    nodeName: string,
    branchId: string,
    hops: number = 2,
  ): Promise<KnowledgeSubgraph | null> {
    const graph = await this.load();
    const centerNode = graph.nodes.find(n => n.name === nodeName && n.branchId === branchId);
    if (!centerNode) return null;

    const visitedNodeIds = new Set<string>();
    const visitedEdgeIds = new Set<string>();
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: centerNode.id, depth: 0 }];
    visitedNodeIds.add(centerNode.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= hops) continue;

      // 找到所有与当前节点相连的边
      const connectedEdges = graph.edges.filter(e =>
        (e.source === current.nodeId || e.target === current.nodeId) &&
        e.branchId === branchId
      );

      for (const edge of connectedEdges) {
        visitedEdgeIds.add(edge.id);

        const neighborId = edge.source === current.nodeId ? edge.target : edge.source;
        if (!visitedNodeIds.has(neighborId)) {
          visitedNodeIds.add(neighborId);
          queue.push({ nodeId: neighborId, depth: current.depth + 1 });
        }
      }
    }

    const nodes = graph.nodes.filter(n => visitedNodeIds.has(n.id));
    const edges = graph.edges.filter(e => visitedEdgeIds.has(e.id));

    // 生成一句话摘要
    const edgeSummary = edges.map(e => {
      const srcName = nodes.find(n => n.id === e.source)?.name || '?';
      const tgtName = nodes.find(n => n.id === e.target)?.name || '?';
      return `${srcName}→${tgtName}(${e.type})`;
    }).join(', ');

    return {
      centerNode,
      nodes,
      edges,
      summary: `图谱邻域查询（${hops}跳）：中心节点${centerNode.name}，关联${nodes.length}个节点、${edges.length}条边。关系：${edgeSummary}`,
    };
  }

  /**
   * 查询两个节点间的最短路径。
   * 用途：一致性检测——"这两个角色之间应该有xxx关系，图谱里有没有这条边？"
   */
  async findPath(
    fromName: string,
    toName: string,
    branchId: string,
  ): Promise<{ edges: KnowledgeEdge[]; nodes: KnowledgeNode[] } | null> {
    const graph = await this.load();
    const fromNode = graph.nodes.find(n => n.name === fromName && n.branchId === branchId);
    const toNode = graph.nodes.find(n => n.name === toName && n.branchId === branchId);
    if (!fromNode || !toNode) return null;

    // BFS 最短路径
    const parentMap = new Map<string, { edge: KnowledgeEdge; node: KnowledgeNode }>();
    const visited = new Set<string>();
    const queue = [fromNode.id];
    visited.add(fromNode.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === toNode.id) break;

      const connectedEdges = graph.edges.filter(e =>
        (e.source === current || e.target === current) && e.branchId === branchId
      );

      for (const edge of connectedEdges) {
        const neighbor = edge.source === current ? edge.target : edge.source;
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        // parentMap 记录"如何到达 neighbor"：经过的边 + 前驱节点（current 对应的节点）
        const currentParentNode = graph.nodes.find(n => n.id === current);
        if (currentParentNode) {
          parentMap.set(neighbor, { edge, node: currentParentNode });
          queue.push(neighbor);
        }
      }
    }

    if (!visited.has(toNode.id)) return null;

    // 回溯路径
    const edges: KnowledgeEdge[] = [];
    const nodes: KnowledgeNode[] = [toNode];
    let curr = toNode.id;
    while (curr !== fromNode.id) {
      const parent = parentMap.get(curr);
      if (!parent) break;
      edges.unshift(parent.edge);
      nodes.unshift(parent.node);
      curr = parent.edge.source === curr ? parent.edge.target : parent.edge.source;
    }

    return { edges, nodes };
  }

  // ==========================================================================
  // 一致性校验（替代 consistency-checker 中的正则匹配）
  // ==========================================================================

  /**
   * 检查生成内容是否违背图谱中已建立的关系。
   *
   * 思路：如果图谱里记录了"A和B是结拜兄弟"，
   * 但生成内容里两人互不认识 → 报错。
   *
   * 这个方法可以替代 consistency-checker.checkCharacterConsistency 里
   * 的 relationship_contradiction 部分。
   */
  async checkRelationshipConsistency(
    segmentContent: string,
    branchId: string,
  ): Promise<Array<{
    severity: 'error' | 'warning';
    edge: KnowledgeEdge;
    sourceName: string;
    targetName: string;
    issue: string;
  }>> {
    const issues: Array<{
      severity: 'error' | 'warning';
      edge: KnowledgeEdge;
      sourceName: string;
      targetName: string;
      issue: string;
    }> = [];

    const graph = await this.load();
    if (!graph || graph.edges.length === 0) return issues;

    const relevantEdges = graph.edges.filter(e => e.branchId === branchId);

    for (const edge of relevantEdges) {
      const srcNode = graph.nodes.find(n => n.id === edge.source);
      const tgtNode = graph.nodes.find(n => n.id === edge.target);
      if (!srcNode || !tgtNode) continue;

      const bothMentioned =
        segmentContent.includes(srcNode.name) &&
        segmentContent.includes(tgtNode.name);
      if (!bothMentioned) continue;

      // 检查矛盾
      if (edge.type === 'conflicts_with') {
        const friendlyKeywords = ['携手', '并肩', '结盟', '友好', '合作', '共', '联合'];
        const context = segmentContent.slice(
          Math.max(0, segmentContent.indexOf(srcNode.name) - 30),
          Math.min(segmentContent.length, segmentContent.indexOf(tgtNode.name) + tgtNode.name.length + 30)
        );
        if (friendlyKeywords.some(kw => context.includes(kw))) {
          issues.push({
            severity: 'error',
            edge,
            sourceName: srcNode.name,
            targetName: tgtNode.name,
            issue: `图谱记录${srcNode.name}与${tgtNode.name}为敌对关系，但生成内容出现友好互动`,
          });
        }
      }

      if (edge.type === 'ally_of' || edge.type === 'belongs_to') {
        const hostileKeywords = ['背叛', '反目', '仇', '杀', '害', '出卖'];
        const context = segmentContent.slice(
          Math.max(0, segmentContent.indexOf(srcNode.name) - 30),
          Math.min(segmentContent.length, segmentContent.indexOf(tgtNode.name) + tgtNode.name.length + 30)
        );
        if (hostileKeywords.some(kw => context.includes(kw))) {
          issues.push({
            severity: 'warning', // ally变敌人可能是情节发展，降级为warning
            edge,
            sourceName: srcNode.name,
            targetName: tgtNode.name,
            issue: `图谱记录${srcNode.name}与${tgtNode.name}为同盟/归属关系，但生成内容出现敌对行为——如确需转变，应有铺垫`,
          });
        }
      }
    }

    return issues;
  }

  // ==========================================================================
  // Prompt 构建方法
  // ==========================================================================

  /**
   * 构建注入 Prompt 的知识图谱上下文区块
   *
   * 设计要点：
   * - 从当前段落出现的角色名/地点名出发，做 BFS 2跳查询
   * - 输出结构化关系描述，让 LLM 在生成时保持关系一致
   */
  async buildPromptContext(
    branchId: string,
    currentCharacters: string[],   // 当前段落中出现的角色名
    currentLocations: string[],    // 当前段落中出现的地名
    hops: number = 2,
  ): Promise<string> {
    const graph = await this.load();
    if (graph.nodes.length === 0) return '';

    // 合并要查询的实体名
    const entityNames = [...currentCharacters, ...currentLocations];
    if (entityNames.length === 0) return '';

    // 对每个实体做 BFS 查询
    const subgraphs: KnowledgeSubgraph[] = [];
    const seenNodeIds = new Set<string>();

    for (const name of entityNames) {
      const sub = await this.queryNeighborhood(name, branchId, hops);
      if (sub && sub.nodes.length > 1) {  // 不止有自己
        subgraphs.push(sub);
        sub.nodes.forEach(n => seenNodeIds.add(n.id));
      }
    }

    if (subgraphs.length === 0) return '';

    // 按节点数排序，取最重要的子图（最多展示3个）
    subgraphs.sort((a, b) => b.nodes.length - a.nodes.length);

    const lines: string[] = [];
    lines.push('## 知识图谱（角色关系与事件关联）');
    lines.push('以下为当前段落涉及的关键实体之间的关系，续写时请确保关系一致：');
    lines.push('');

    for (const sub of subgraphs.slice(0, 3)) {
      // 输出节点
      const charNodes = sub.nodes.filter(n => n.type === 'character');
      const locNodes = sub.nodes.filter(n => n.type === 'location');
      const eventNodes = sub.nodes.filter(n => n.type === 'event');
      const factionNodes = sub.nodes.filter(n => n.type === 'faction');

      if (charNodes.length > 0) {
        lines.push(`角色：${charNodes.map(n => n.name).join('、')}`);
      }
      if (locNodes.length > 0) {
        lines.push(`地点：${locNodes.map(n => n.name).join('、')}`);
      }
      if (eventNodes.length > 0) {
        lines.push(`事件：${eventNodes.map(n => n.name).join('、')}`);
      }
      if (factionNodes.length > 0) {
        lines.push(`势力：${factionNodes.map(n => n.name).join('、')}`);
      }

      // 输出边（关系）
      if (sub.edges.length > 0) {
        const edgeLines = sub.edges.map(e => {
          const srcNode = sub.nodes.find(n => n.id === e.source);
          const tgtNode = sub.nodes.find(n => n.id === e.target);
          if (!srcNode || !tgtNode) return '';

          const typeLabel: Record<EdgeType, string> = {
            causes: '导致', leads_to: '引向', located_at: '位于',
            involves: '参与', conflicts_with: '敌对', ally_of: '同盟',
            belongs_to: '隶属于', precedes: '先于', parallel_to: '平行（跨分支）',
          };

          return `  - ${srcNode.name} → ${typeLabel[e.type]} → ${tgtNode.name}`;
        }).filter(Boolean);

        if (edgeLines.length > 0) {
          lines.push('关系链路：');
          lines.push(...edgeLines);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  // ==========================================================================
  // 从段落自动抽取节点和边（使用 LLM）
  // ==========================================================================

  /**
   * 让 LLM 从段落内容中抽取实体和关系，自动构建图。
   *
   * 这是 DOME 的知识图谱构建流程——每生成一段新内容就抽取一次。
   * 抽取失败静默降级，不阻塞主流程。
   */
  async extractFromSegment(
    segmentContent: string,
    branchId: string,
    segmentId: string,
    callAIFn: (prompt: string) => Promise<string>,
  ): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
    const prompt = `从以下故事段落中提取关键实体及其关系，输出JSON。

段落：
${segmentContent.slice(0, 2500)}

请输出严格JSON（不要markdown、不要解释）：
{
  "entities": [
    {
      "type": "character|location|faction|event|branch_point",
      "name": "实体名（中文）",
      "properties": { "关键属性": "值" }
    }
  ],
  "relations": [
    {
      "from": "实体A的名字",
      "to": "实体B的名字",
      "type": "causes|leads_to|located_at|involves|conflicts_with|ally_of|belongs_to|precedes",
      "note": "关系简述"
    }
  ]
}

## 抽取指南
- 实体名用最常用的名字（不要代称），第一个实体就是最重要的
- 关系类型：causes=导致，leads_to=叙事流程导向，located_at=在某个地点，
  involves=参与某事，conflicts_with=敌对/冲突，ally_of=同盟/友好，
  belongs_to=属于某个势力/组织，precedes=时间上先于
- 每个实体最多抽取1-2个最关键属性`;

    try {
      const raw = await callAIFn(prompt);
      // 清理格式
      const cleaned = raw.trim()
        .replace(/^```json\s*/i, '')
        .replace(/```$/g, '')
        .trim();

      const parsed = JSON.parse(cleaned);

      const entities = parsed.entities || [];
      const relations = parsed.relations || [];

      // 批量创建节点
      const newNodes: KnowledgeNode[] = [];
      const nameToNodeId = new Map<string, string>();

      for (const ent of entities) {
        if (!ent.name || !ent.type) continue;
        const node = await this.getOrCreateNode({
          type: ent.type,
          name: ent.name,
          branchId,
          properties: ent.properties || {},
          segmentId,
        });
        newNodes.push(node);
        nameToNodeId.set(ent.name, node.id);
      }

      // 批量创建边
      const newEdges: KnowledgeEdge[] = [];
      for (const rel of relations) {
        const fromId = nameToNodeId.get(rel.from);
        const toId = nameToNodeId.get(rel.to);
        if (!fromId || !toId) continue;
        if (!rel.type) continue;

        try {
          const edge = await this.addEdge({
            source: fromId,
            target: toId,
            type: rel.type,
            branchId,
            properties: { note: rel.note || '' },
            segmentId,
          });
          newEdges.push(edge);
        } catch (e) {
          // 边已存在或节点不存在，跳过
        }
      }

      return { nodes: newNodes, edges: newEdges };
    } catch (e) {
      console.warn('[knowledge-graph] 段落实体抽取失败:', e);
      return { nodes: [], edges: [] };
    }
  }

  /**
   * 获取图谱统计信息（用于调试/汇报）
   */
  async getStats(): Promise<{
    totalNodes: number;
    totalEdges: number;
    nodeByType: Record<NodeType, number>;
    edgeByType: Record<EdgeType, number>;
    largestComponent: number;
  }> {
    const graph = await this.load();

    const nodeByType: Record<NodeType, number> = {
      character: 0, event: 0, location: 0, branch_point: 0, faction: 0,
    };
    for (const n of graph.nodes) nodeByType[n.type]++;

    const edgeByType: Record<EdgeType, number> = {
      causes: 0, leads_to: 0, located_at: 0, involves: 0,
      conflicts_with: 0, ally_of: 0, belongs_to: 0, precedes: 0,
      parallel_to: 0,
    };
    for (const e of graph.edges) edgeByType[e.type]++;

    return {
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length,
      nodeByType,
      edgeByType,
      largestComponent: -1,  // 暂不计算连通分量
    };
  }

  /**
   * 测试用：重置为空图谱，避免污染 data/ 目录
   */
  async resetForTest(): Promise<void> {
    this.data = { nodes: [], edges: [], version: 1, updatedAt: new Date().toISOString() };
    this.initialized = true;
    await this.save();
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const knowledgeGraph = new KnowledgeGraph();
export type { GraphData };
