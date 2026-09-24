import type { MenuItem } from '../lib/api';

/**
 * Unsplash license attribution, deliberately unobtrusive: a small caption
 * in the image corner linking to the photographer and to Unsplash (both
 * carry the utm_source parameters the API guidelines require).
 */
export function ImageCredit({ item }: { item: MenuItem }) {
  if (!item.image_url || !item.image_photographer) return null;
  return (
    <span className="absolute bottom-1 right-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] leading-tight text-white/90">
      Photo by{' '}
      <a
        href={item.image_photographer_url ?? undefined}
        target="_blank"
        rel="noreferrer"
        className="underline"
        onClick={(e) => e.stopPropagation()}
      >
        {item.image_photographer}
      </a>{' '}
      on{' '}
      <a
        href={item.image_unsplash_url ?? undefined}
        target="_blank"
        rel="noreferrer"
        className="underline"
        onClick={(e) => e.stopPropagation()}
      >
        Unsplash
      </a>
    </span>
  );
}
