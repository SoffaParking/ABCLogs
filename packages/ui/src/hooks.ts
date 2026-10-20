import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'wouter';

/** The URL's query parameters, and a setter that patches some and keeps the rest. */
export function useQueryState(): [
  URLSearchParams,
  (patch: Record<string, string | null | undefined>, options?: { replace?: boolean }) => void,
] {
  const [params, setParams] = useSearchParams();
  const patch = useCallback(
    (changes: Record<string, string | null | undefined>, options?: { replace?: boolean }) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === undefined || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      }, options);
    },
    [setParams],
  );
  return [params, patch];
}

/** The rendered width of an element, kept current as it resizes. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Value saved in localStorage, falling back to the default where storage is unavailable. */
export function useStoredState<T extends string>(
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // storage blocked: keep it for this page only
      }
    },
    [key],
  );
  return [value, set];
}
