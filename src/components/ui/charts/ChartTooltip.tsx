import { ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../primitives/shared';

interface ChartTooltipProps {
  /** Horizontal anchor as a 0..100 percentage of the chart's width. */
  x: number;
  children: ReactNode;
  className?: string;
}

/**
 * Small bubble above a chart point. It is centred on its anchor and clamped, by the rendered widths
 * of the bubble and the chart, so it never spills out of the chart; a bubble wider than the chart
 * wraps at the chart's width.
 */
export function ChartTooltip({ x, children, className }: ChartTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Left edge in px inside the chart, once measured; until then the old percentage estimate.
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const bubble = ref.current;
    const chart = bubble?.offsetParent as HTMLElement | null;
    if (!bubble || !chart) return;
    const chartWidth = chart.clientWidth;
    const bubbleWidth = bubble.offsetWidth;
    const centred = (x / 100) * chartWidth - bubbleWidth / 2;
    setLeft(Math.min(Math.max(centred, 0), Math.max(0, chartWidth - bubbleWidth)));
  }, [x, children]);
  const shift = x < 15 ? '0%' : x > 85 ? '-100%' : '-50%';
  return (
    <div
      ref={ref}
      role="presentation"
      className={cx(
        'pointer-events-none absolute bottom-full mb-2 z-10 w-max max-w-full rounded-lg border border-overlay-default bg-bg-800/95 px-2 py-1 text-micro font-medium tabular-nums text-content-primary shadow-lg backdrop-blur-md motion-safe:animate-enter-fade',
        className
      )}
      style={left === null ? { left: `${x}%`, transform: `translateX(${shift})` } : { left: `${left}px` }}
    >
      {children}
    </div>
  );
}
