import { useSyncExternalStore } from 'react';

/**
 * Shared "currently selected store" — the order page's selector writes it,
 * the floating barista chat (mounted in the layout, on every page) reads it
 * for the store-hint prefix. Backed by localStorage so the choice survives
 * reloads; subscribers are notified so the chat's hint follows the selector.
 */
const KEY = 'daiwt-coffee-store';

let current = localStorage.getItem(KEY) ?? '';
const listeners = new Set<() => void>();

export function getStoreId(): string {
  return current;
}

export function setStoreId(id: string): void {
  localStorage.setItem(KEY, id);
  if (id === current) return;
  current = id;
  for (const l of listeners) l();
}

export function useStoreId(): string {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, getStoreId);
}
