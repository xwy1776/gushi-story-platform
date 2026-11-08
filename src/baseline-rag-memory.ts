/**
 * 内存版 RAG 外部基线。
 *
 * 设计目标：
 * - 不依赖向量数据库，实验时可以逐故事 clear，避免样本间串数据；
 * - 有 embedding 配置时走向量检索；
 * - 当前项目使用 DeepSeek 文本模型、没有 embedding 端点时，自动退化为
 *   中文字符二元组 BM25 检索，而不是静默返回空串。
 *
 * 这不是“假 RAG”：BM25 本身就是经典的 retrieval baseline。论文中应如实写成
 * “BM25 检索式记忆”，除非配置了真实 embedding 模型。
 */

export type RagDocument = {
  text: string;
  id?: string;
  branchId?: string;
  metadata?: Record<string, string>;
};

export type MemoryRAGBaselineOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  disableEmbeddings?: boolean;
};

type StoredDocument = RagDocument & {
  embedding?: number[];
  termCounts: Map<string, number>;
  termCount: number;
};

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().normalize('NFKC');
  const runs = normalized.match(/[a-z0-9_]+|[\u3400-\u9fff]+/g) ?? [];
  const tokens: string[] = [];

  for (const run of runs) {
    if (/^[a-z0-9_]+$/.test(run)) {
      if (run.length > 1) tokens.push(run);
      continue;
    }

    // 中文不按字切：单字过于泛化，二元组对人物、地点和事件名更稳。
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

function buildTermCounts(text: string): Pick<StoredDocument, 'termCounts' | 'termCount'> {
  const termCounts = new Map<string, number>();
  const tokens = tokenize(text);
  for (const token of tokens) {
    termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
  }
  return { termCounts, termCount: tokens.length };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export class MemoryRAGBaseline {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly disableEmbeddings: boolean;
  private readonly docs: StoredDocument[] = [];
  private embeddingFailureReported = false;

  constructor(options: string | MemoryRAGBaselineOptions = {}) {
    const opts = typeof options === 'string' ? { apiKey: options } : options;
    this.apiKey = opts.apiKey
      ?? process.env.AI_EMBEDDING_API_KEY
      ?? process.env.OPENAI_API_KEY
      ?? process.env.AI_API_KEY
      ?? '';
    this.baseUrl = (
      opts.baseUrl
      ?? process.env.AI_EMBEDDING_BASE_URL
      ?? process.env.AI_BASE_URL
      ?? 'https://api.openai.com/v1'
    ).replace(/\/+$/, '');
    this.model = opts.model
      ?? process.env.AI_EMBEDDING_MODEL
      ?? '';
    this.disableEmbeddings = opts.disableEmbeddings === true || !this.model || !this.apiKey;
  }

  get embeddingEnabled(): boolean {
    return !this.disableEmbeddings && !this.embeddingFailureReported;
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * 批量写入文档。没有 embedding 配置时只建 BM25 倒排统计。
   */
  async addTexts(textList: Array<string | RagDocument>): Promise<void> {
    for (const item of textList) {
      const doc: RagDocument = typeof item === 'string' ? { text: item } : item;
      if (!doc.text.trim()) continue;
      const stored: StoredDocument = {
        ...doc,
        ...buildTermCounts(doc.text),
      };
      if (this.embeddingEnabled) {
        const embedding = await this.getEmbedding(doc.text);
        if (embedding) stored.embedding = embedding;
      }
      this.docs.push(stored);
    }
  }

  /**
   * 返回按相关度排序的文档；branchId 仅作记录，默认不过滤——
   * “单线共享记忆”正是外部 RAG 基线的实验条件。
   */
  async retrieveDocs(query: string, topK = 3): Promise<RagDocument[]> {
    if (this.docs.length === 0 || !query.trim()) return [];
    const k = Math.max(1, topK);

    if (this.embeddingEnabled && this.docs.every(doc => doc.embedding)) {
      const queryEmbedding = await this.getEmbedding(query);
      if (queryEmbedding) {
        return this.docs
          .map(doc => ({
            doc,
            score: cosineSimilarity(queryEmbedding, doc.embedding ?? []),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k)
          .map(({ doc }) => this.toPublicDoc(doc));
      }
    }

    return this.retrieveLexical(query, k).map(({ doc }) => this.toPublicDoc(doc));
  }

  /**
   * 与实验脚本保持简单接口：直接返回可拼进 Prompt 的文本。
   */
  async retrieve(query: string, topK = 3): Promise<string> {
    const docs = await this.retrieveDocs(query, topK);
    return docs.map(doc => doc.text).join('\n---\n');
  }

  clear(): void {
    this.docs.length = 0;
  }

  private retrieveLexical(query: string, topK: number): Array<{ doc: StoredDocument; score: number }> {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0) return [];

    const docFreq = new Map<string, number>();
    for (const term of queryTerms) {
      let count = 0;
      for (const doc of this.docs) {
        if (doc.termCounts.has(term)) count++;
      }
      docFreq.set(term, count);
    }

    const avgLength = this.docs.reduce((sum, doc) => sum + doc.termCount, 0) / this.docs.length;
    const k1 = 1.5;
    const b = 0.75;

    return this.docs
      .map(doc => {
        let score = 0;
        for (const term of queryTerms) {
          const tf = doc.termCounts.get(term) ?? 0;
          if (tf === 0) continue;
          const df = docFreq.get(term) ?? 0;
          const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
          const denominator = tf + k1 * (1 - b + b * (doc.termCount / (avgLength || 1)));
          score += idf * ((tf * (k1 + 1)) / denominator);
        }
        return { doc, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    if (this.disableEmbeddings) return null;

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model || DEFAULT_EMBEDDING_MODEL,
          input: text,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const payload = await response.json() as {
        data?: Array<{ embedding?: number[] }>;
      };
      const embedding = payload.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('响应中没有 embedding');
      }
      return embedding;
    } catch (error) {
      if (!this.embeddingFailureReported) {
        this.embeddingFailureReported = true;
        console.warn(
          `[MemoryRAGBaseline] embedding 不可用，自动退化为 BM25 检索：${(error as Error).message}`,
        );
      }
      return null;
    }
  }

  private toPublicDoc(doc: StoredDocument): RagDocument {
    return {
      text: doc.text,
      id: doc.id,
      branchId: doc.branchId,
      metadata: doc.metadata,
    };
  }
}
