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

/**
 * Text used to embed a menu item: name + category + description, plus a
 * generated nutrition/allergen/scene sentence so semantic search can answer
 * health-oriented queries (「カロリー控えめ」「高タンパク」「乳成分なし」).
 */
export function menuEmbeddingText(item: {
  item_name: string;
  category: string;
  description: string;
  calories_kcal?: number | null;
  protein_g?: string | null;
  fat_g?: string | null;
  contains_milk?: boolean | null;
  alt_milk_options?: string | null;
  scenes?: string | null;
  is_seasonal?: boolean | null;
  is_new?: boolean | null;
  is_classic?: boolean | null;
}): string {
  const parts = [`${item.item_name} / ${item.category} / ${item.description}`];
  const facts: string[] = [];
  if (item.calories_kcal != null) facts.push(`${item.calories_kcal}kcal`);
  if (item.protein_g != null) facts.push(`タンパク質${item.protein_g}g`);
  if (item.fat_g != null) facts.push(`脂質${item.fat_g}g`);
  if (item.contains_milk === true) {
    facts.push('乳成分あり');
    if (item.alt_milk_options) facts.push(`代替乳に変更可(${item.alt_milk_options})`);
  } else if (item.contains_milk === false) {
    facts.push('乳成分なし');
  }
  if (item.scenes) facts.push(`シーン: ${item.scenes.split(',').join('・')}`);
  if (item.is_seasonal) facts.push('季節限定');
  if (item.is_new) facts.push('新商品');
  if (item.is_classic) facts.push('定番');
  if (facts.length > 0) parts.push(`[${facts.join(' / ')}]`);
  return parts.join(' ').slice(0, 2000);
}
