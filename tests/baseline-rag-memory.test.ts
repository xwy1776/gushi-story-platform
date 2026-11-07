import { describe, expect, it } from 'vitest';
import { MemoryRAGBaseline } from '../src/baseline-rag-memory';

describe('MemoryRAGBaseline', () => {
  it('uses BM25 when embeddings are not configured', async () => {
    const rag = new MemoryRAGBaseline({ disableEmbeddings: true });
    await rag.addTexts([
      { id: 'a', branchId: 'A', text: '刘备向公孙瓒借兵，驻扎北平。' },
      { id: 'b', branchId: 'B', text: '刘备向陶谦借兵，驻扎徐州。' },
      { id: 'c', branchId: 'A', text: '关羽与张飞在桃园结义。' },
    ]);

    expect(rag.embeddingEnabled).toBe(false);
    expect(rag.size).toBe(3);

    const docs = await rag.retrieveDocs('陶谦 徐州 借兵', 2);
    expect(docs).toHaveLength(2);
    expect(docs[0].text).toContain('陶谦');
    expect(docs[0].branchId).toBe('B');
  });

  it('clears documents between stories and respects top-k', async () => {
    const rag = new MemoryRAGBaseline({ disableEmbeddings: true });
    await rag.addTexts([
      '刘备与公孙瓒结盟。',
      '刘备与陶谦结盟。',
      '曹操率军南下。',
    ]);

    expect(await rag.retrieveDocs('刘备 结盟', 1)).toHaveLength(1);
    expect(await rag.retrieve('完全无关的查询')).toBe('');
    rag.clear();
    expect(rag.size).toBe(0);
    expect(await rag.retrieveDocs('刘备', 3)).toEqual([]);
  });
});
