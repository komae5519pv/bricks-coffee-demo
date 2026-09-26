import { useEffect, useState } from 'react';

/**
 * Ticking clock for live relative-time displays (「○秒前」). Re-renders the
 * caller every intervalMs while mounted.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** 'たった今' / '12秒前' / '3分前' / '2時間前' / absolute date for old timestamps. */
export function fmtAgo(iso: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (secs < 10) return 'たった今';
  if (secs < 60) return `${secs}秒前`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  return new Date(iso).toLocaleDateString('ja-JP');
}
