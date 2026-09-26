import { describe, it, expect } from 'vitest';
import { fmtAgo } from './use-now';

const NOW = new Date('2026-09-26T12:00:00Z').getTime();
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString();

describe('fmtAgo', () => {
  it('is たった今 under 10 seconds', () => {
    expect(fmtAgo(ago(0), NOW)).toBe('たった今');
    expect(fmtAgo(ago(9), NOW)).toBe('たった今');
  });

  it('counts seconds under a minute', () => {
    expect(fmtAgo(ago(10), NOW)).toBe('10秒前');
    expect(fmtAgo(ago(59), NOW)).toBe('59秒前');
  });

  it('counts minutes under an hour', () => {
    expect(fmtAgo(ago(60), NOW)).toBe('1分前');
    expect(fmtAgo(ago(3599), NOW)).toBe('59分前');
  });

  it('counts hours under a day', () => {
    expect(fmtAgo(ago(3600), NOW)).toBe('1時間前');
    expect(fmtAgo(ago(86399), NOW)).toBe('23時間前');
  });

  it('never goes negative on clock skew', () => {
    expect(fmtAgo(new Date(NOW + 5000).toISOString(), NOW)).toBe('たった今');
  });
});
