import { useEffect, useRef, useState } from 'react';

/**
 * Tweened number display: live KPI updates animate from the current value
 * (interruptible — a newer value re-targets mid-flight), driven by rAF so a
 * re-render never restarts it. transform/opacity-free (textContent swap at
 * 60fps is fine for a number). Reduced-motion: snaps instantly.
 */
export function useTweenedNumber(target: number, durationMs = 600): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = target;
      // sync setState in effect is fine here (user preference, not data)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplay(target);
      return;
    }
    if (target === fromRef.current) return;
    const from = fromRef.current;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out cubic (fast start, gentle settle)
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(from + (target - from) * eased);
      setDisplay(current);
      fromRef.current = current;
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return display;
}