import { useState } from 'react';
import { menuImageSrc, type MenuItem } from '../lib/api';
import { ImageCredit } from './ImageCredit';

/**
 * Menu item photo (Unsplash hotlink) with attribution.
 * On load failure the whole block collapses (no broken-image icon).
 */
export function MenuImage({
  item,
  width,
  className = '',
  creditVariant = 'overlay',
}: {
  item: MenuItem;
  width: number;
  className?: string;
  creditVariant?: 'overlay' | 'inline';
}) {
  const [failed, setFailed] = useState(false);
  const src = menuImageSrc(item, width);
  if (!src || failed) return null;
  return (
    <div className={className}>
      <div className="relative h-full w-full overflow-hidden rounded bg-muted">
        <img
          src={src}
          alt={item.item_name}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
        {creditVariant === 'overlay' && <ImageCredit item={item} variant="overlay" />}
      </div>
      {creditVariant === 'inline' && <ImageCredit item={item} variant="inline" />}
    </div>
  );
}
