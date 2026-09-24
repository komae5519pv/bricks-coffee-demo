import type { MenuItem } from '../lib/api';

/**
 * Unsplash license attribution, deliberately unobtrusive. Every surface that
 * renders an Unsplash hotlink must show it (API license requirement):
 * "Photo by {photographer} on Unsplash" with utm-tagged links to the
 * photographer and to Unsplash.
 *
 * variant="overlay" — small caption in the image corner (order tab cards).
 * variant="inline"  — plain text line, for spots too small for an overlay
 *                     (admin table thumbnails).
 */
export function ImageCredit({ item, variant = 'overlay' }: { item: MenuItem; variant?: 'overlay' | 'inline' }) {
  if (!item.image_url || !item.image_photographer) return null;
  const cls =
    variant === 'overlay'
      ? 'absolute bottom-1 right-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] leading-tight text-white/90'
      : 'block text-[10px] leading-tight text-muted-foreground';
  return (
    <span className={cls}>
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
