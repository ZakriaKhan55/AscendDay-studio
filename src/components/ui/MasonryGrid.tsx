import { Children, type ReactElement, type ReactNode, isValidElement, useLayoutEffect, useRef, useState } from 'react';

/** Matches the gap-4 between columns and between cards. */
const GAP_REM = 1;

/**
 * Cards of different heights in columns that each stack on their own, so a tall or expanded card
 * only pushes down its own column instead of stretching a whole row and leaving holes beside it.
 * Native masonry (display: grid-lanes) is Safari-only as of 2026, hence the measured columns.
 *
 * Columns follow the width like .grid-cards (as many as fit at the minimum width). Each card, in
 * list order, goes to the column that is shortest at that point. Placement is worked out again
 * only when the cards or the column count change, never when a card grows, so expanding a card
 * never makes the others jump columns. Children need keys.
 *
 * Every card sits directly in one parent and is positioned in its column, so a column-count change
 * (window resize, sidebar fold, phone rotation) moves cards without remounting them: an expanded
 * card stays expanded and focus stays where it was.
 */
export function MasonryGrid({ children, minColumnRem }: { children: ReactNode; minColumnRem: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);
  const items = Children.toArray(children).filter(isValidElement) as ReactElement[];
  const keys = items.map((item) => String(item.key));
  const placement = useRef<{ signature: string; columnOf: Record<string, number> } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const gap = GAP_REM * rem;
      setColumnCount(Math.max(1, Math.floor((el.clientWidth + gap) / (minColumnRem * rem + gap))));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [minColumnRem]);

  const signature = `${columnCount}#${JSON.stringify(keys)}`;

  // Before the browser paints: place a new set of cards (or a new column count) by their measured
  // heights, then stack each column. A card that changes height later (Show more, an image)
  // restacks only the cards under it in its own column.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cards = Array.from(el.children) as HTMLElement[];
    const gap = GAP_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const keyOf = (card: HTMLElement) => card.getAttribute('data-masonry-key') as string;
    if (placement.current?.signature !== signature) {
      const columnHeights = new Array<number>(columnCount).fill(0);
      const columnOf: Record<string, number> = {};
      for (const card of cards) {
        const shortest = columnHeights.indexOf(Math.min(...columnHeights));
        columnOf[keyOf(card)] = shortest;
        columnHeights[shortest] += card.offsetHeight + gap;
      }
      placement.current = { signature, columnOf };
    }
    const { columnOf } = placement.current;
    const stack = () => {
      const tops = new Array<number>(columnCount).fill(0);
      for (const card of cards) {
        const column = columnOf[keyOf(card)] ?? 0;
        card.style.left = `calc(${column} * (100% + ${GAP_REM}rem) / ${columnCount})`;
        card.style.top = `${tops[column]}px`;
        tops[column] += card.offsetHeight + gap;
      }
      el.style.height = `${Math.max(0, Math.max(...tops) - gap)}px`;
    };
    stack();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(stack);
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [signature, columnCount]);

  return (
    <div ref={ref} className="relative">
      {items.map((item, i) => (
        <div
          key={keys[i]}
          data-masonry-key={keys[i]}
          className="absolute"
          style={{ width: `calc((100% - ${(columnCount - 1) * GAP_REM}rem) / ${columnCount})` }}
        >
          {item}
        </div>
      ))}
    </div>
  );
}
