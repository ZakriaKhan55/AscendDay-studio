import { useEffect, type RefObject } from 'react';

/**
 * Marks a horizontal scroller with `data-fade-start` / `data-fade-end` while content is hidden
 * past that edge, so `.scroll-fade` (index.css) can fade the edge and hint that more is there.
 * Writes attributes directly, so scrolling never re-renders the component. Children added or removed
 * later (more tabs) are measured too.
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.toggleAttribute('data-fade-start', el.scrollLeft > 1);
      el.toggleAttribute('data-fade-end', el.scrollLeft < max - 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    const children = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => node instanceof Element && observer.observe(node));
        record.removedNodes.forEach((node) => node instanceof Element && observer.unobserve(node));
      }
      update();
    });
    children.observe(el, { childList: true });
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
      children.disconnect();
      el.removeAttribute('data-fade-start');
      el.removeAttribute('data-fade-end');
    };
  }, [ref, enabled]);
}
