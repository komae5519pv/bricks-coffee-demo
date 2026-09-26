import type { MenuItem } from './api';

export const MAX_RECOMMENDATION_CARDS = 6;

/**
 * Deterministic safety net for chat product cards. Search tools can fire
 * several times per turn (broad exploration -> narrowing); rendering every
 * round leaves cards for products the final answer never recommends.
 * This keeps only items whose OFFICIAL item_name appears verbatim in the
 * assistant's final text, deduplicated by SKU (first occurrence wins), in
 * tool-result order, capped at `max`.
 */
export function reconcileRecommendations(
  items: MenuItem[],
  assistantText: string,
  max = MAX_RECOMMENDATION_CARDS,
): MenuItem[] {
  const seen = new Set<string>();
  const out: MenuItem[] = [];
  for (const item of items) {
    if (!item || typeof item.sku !== 'string' || seen.has(item.sku)) continue;
    seen.add(item.sku);
    if (!assistantText.includes(item.item_name)) continue;
    out.push(item);
  }
  return out.slice(0, max);
}
