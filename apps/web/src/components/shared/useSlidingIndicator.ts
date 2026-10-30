import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

type Box = { x: number; y: number; w: number; h: number };

/**
 * Measures the active child of a container so one indicator element can glide between items.
 * Only `transform` is animated; size is applied instantly. Returns no style until measured,
 * and `ready` stays false for the first frame so the indicator does not slide in from 0,0.
 */
export function useSlidingIndicator<T extends HTMLElement>(
  activeSelector: string,
  key: unknown,
  mode: 'fill' | 'underline' = 'fill',
) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const measure = () => {
      const active = container.querySelector<HTMLElement>(activeSelector);
      setBox(
        active
          ? {
              x: active.offsetLeft,
              y: active.offsetTop,
              w: active.offsetWidth,
              h: active.offsetHeight,
            }
          : null,
      );
    };
    measure();
    const frame = requestAnimationFrame(() => setReady(true));
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSelector, key]);
  const style: CSSProperties | undefined = box
    ? mode === 'underline'
      ? { width: box.w, transform: `translate3d(${box.x}px, ${box.y + box.h - 2}px, 0)` }
      : { width: box.w, height: box.h, transform: `translate3d(${box.x}px, ${box.y}px, 0)` }
    : undefined;
  return { ref, style, ready: ready && Boolean(box) };
}
