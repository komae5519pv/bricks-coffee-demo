import { describe, it, expect } from 'vitest';
import { embedTexts, menuEmbeddingText, toVectorLiteral, EMBEDDING_DIMS, type EmbeddingsInvoker } from './embed';

function mockServing(embeddings: number[][]): EmbeddingsInvoker {
  return {
    invoke: () =>
      Promise.resolve({ ok: true as const, data: { data: embeddings.map((embedding) => ({ embedding })) } }),
  };
}

describe('toVectorLiteral', () => {
  it('renders a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe('[0.1,0.2,-0.3]');
  });
});

describe('menuEmbeddingText', () => {
  it('joins name, category and description', () => {
    expect(menuEmbeddingText({ item_name: 'ラテ', category: 'Espresso', description: 'ミルク入り' })).toBe(
      'ラテ / Espresso / ミルク入り',
    );
  });
});

describe('embedTexts', () => {
  it('returns embeddings for each input', async () => {
    const vec = Array.from({ length: EMBEDDING_DIMS }, () => 0.5);
    const out = await embedTexts(mockServing([vec, vec]), ['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(EMBEDDING_DIMS);
  });

  it('throws when the endpoint returns the wrong shape', async () => {
    const bad: EmbeddingsInvoker = {
      invoke: () => Promise.resolve({ ok: false as const, status: 500, message: 'boom' }),
    };
    await expect(embedTexts(bad, ['x'])).rejects.toThrow('embedding endpoint error (500): boom');
  });
});
