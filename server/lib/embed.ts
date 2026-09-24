/**
 * Text embeddings via a Databricks Foundation Model API endpoint
 * (databricks-qwen3-embedding-0-6b, multilingual, 1024 dims), called through
 * the serving plugin so auth, retries and telemetry stay on the AppKit rails.
 */
export const EMBEDDING_DIMS = 1024;

/** Minimal shape both the AppKit exports handle and the plugin instance satisfy. */
export interface EmbeddingsInvoker {
  invoke(
    alias: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string }>;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}

/** Embed a batch of texts. Throws with the endpoint's message on failure. */
export async function embedTexts(
  serving: EmbeddingsInvoker,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await serving.invoke('embeddings', { input: texts });
  if (!res.ok) {
    throw new Error(`embedding endpoint error (${res.status}): ${res.message}`);
  }
  const body = res.data as EmbeddingsResponse;
  if (!Array.isArray(body.data)) {
    // diagnostic: surface the real envelope shape instead of a bare TypeError
    throw new Error(
      `embedding endpoint returned non-array data. shape=${JSON.stringify(res.data)?.slice(0, 300)}`,
    );
  }
  const out = body.data.map((d) => d.embedding ?? []);
  if (out.length !== texts.length || out.some((e) => e.length !== EMBEDDING_DIMS)) {
    throw new Error(
      `embedding endpoint returned ${out.length} vectors for ${texts.length} inputs`,
    );
  }
  return out;
}

/** pgvector literal: '[0.1,0.2,...]' */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Text used to embed a menu item (name + category + description). */
export function menuEmbeddingText(item: {
  item_name: string;
  category: string;
  description: string;
}): string {
  return `${item.item_name} / ${item.category} / ${item.description}`.slice(0, 2000);
}
