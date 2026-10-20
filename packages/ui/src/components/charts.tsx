import { useState, type ReactNode } from 'react';
import { formatFullTime, formatTick } from '../format';
import { useWidth } from '../hooks';

export interface Series {
  key: string;
  label: string;
  /** CSS class that colours this series (see styles.css, `.c-*`). */
  className: string;
}

type Point = { t: string } & Record<string, unknown>;

const PAD = { top: 10, right: 10, bottom: 24, left: 48 };

/** A round axis maximum at or above `value`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * magnitude >= value) return m * magnitude;
  return 10 * magnitude;
}

function num(point: Point, key: string): number | null {
  const value = point[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface FrameProps {
  data: Point[];
  height: number;
  yMax: number;
  formatY: (value: number) => string;
  label: string;
  children: (geometry: Geometry) => ReactNode;
  tooltip: (point: Point) => ReactNode;
}

interface Geometry {
  width: number;
  innerWidth: number;
  innerHeight: number;
  /** Left edge of slot `i`. */
  x: (i: number) => number;
  slot: number;
  y: (value: number) => number;
  hover: number | null;
}

/** Axes, grid lines, hover tracking and the tooltip; the chart draws inside. */
function Frame({ data, height, yMax, formatY, label, children, tooltip }: FrameProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const innerWidth = Math.max(0, width - PAD.left - PAD.right);
  const innerHeight = height - PAD.top - PAD.bottom;
  const slot = data.length > 0 ? innerWidth / data.length : innerWidth;
  const geometry: Geometry = {
    width,
    innerWidth,
    innerHeight,
    slot,
    x: (i) => PAD.left + i * slot,
    y: (value) => PAD.top + innerHeight - (Math.min(value, yMax) / yMax) * innerHeight,
    hover,
  };
  const span = data.length > 1 ? Date.parse(data[data.length - 1]!.t) - Date.parse(data[0]!.t) : 0;
  const tickEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerWidth / 90))));
  const hovered = hover === null ? undefined : data[hover];

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {[0, 0.5, 1].map((share) => {
            const y = PAD.top + innerHeight - share * innerHeight;
            return (
              <g key={share}>
                <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
                <text className="axis" x={PAD.left - 6} y={y + 4} textAnchor="end">
                  {share === 0 ? '0' : formatY(yMax * share)}
                </text>
              </g>
            );
          })}
          {data.map((point, i) =>
            i % tickEvery === 0 ? (
              <text
                key={point.t}
                className="axis"
                x={geometry.x(i) + slot / 2}
                y={height - 6}
                textAnchor="middle"
              >
                {formatTick(point.t, span)}
              </text>
            ) : null,
          )}
          {children(geometry)}
          <rect
            className="hit"
            x={PAD.left}
            y={PAD.top}
            width={innerWidth}
            height={innerHeight}
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const i = Math.floor((e.clientX - box.left) / slot);
              setHover(i >= 0 && i < data.length ? i : null);
            }}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hovered && hover !== null && (
        <div
          className="tooltip"
          style={{
            left: Math.min(geometry.x(hover) + slot / 2 + 12, width - 190),
            top: PAD.top,
          }}
        >
          <div className="tooltip-time">{formatFullTime(hovered.t)}</div>
          {tooltip(hovered)}
        </div>
      )}
    </div>
  );
}

function TooltipRows({
  point,
  series,
  format,
}: {
  point: Point;
  series: Series[];
  format: (v: number | null) => string;
}) {
  return (
    <>
      {series.map((s) => (
        <div key={s.key} className="tooltip-row">
          <span className={`swatch ${s.className}`} />
          <span>{s.label}</span>
          <span className="tooltip-value">{format(num(point, s.key))}</span>
        </div>
      ))}
    </>
  );
}

/** Bars stacked bottom-up in the order of `series`. */
export function StackedBars({
  data,
  series,
  height = 180,
  format,
  label,
}: {
  data: Point[];
  series: Series[];
  height?: number;
  format: (value: number | null) => string;
  label: string;
}) {
  const totals = data.map((point) => series.reduce((sum, s) => sum + (num(point, s.key) ?? 0), 0));
  // Bars are counts: an axis of at least 2 keeps the middle grid line a whole number.
  const yMax = Math.max(2, niceMax(Math.max(0, ...totals)));
  return (
    <Frame
      data={data}
      height={height}
      yMax={yMax}
      formatY={(v) => format(v)}
      label={label}
      tooltip={(point) => (
        <TooltipRows point={point} series={[...series].reverse()} format={format} />
      )}
    >
      {(g) => {
        const gap = g.slot > 4 ? 1 : 0;
        return data.map((point, i) => {
          let base = 0;
          return (
            <g key={point.t} className={g.hover === i ? 'bar hovered' : 'bar'}>
              {series.map((s) => {
                const value = num(point, s.key) ?? 0;
                if (value <= 0) return null;
                const top = g.y(base + value);
                const bottom = g.y(base);
                base += value;
                return (
                  <rect
                    key={s.key}
                    className={s.className}
                    x={g.x(i) + gap / 2}
                    y={top}
                    width={Math.max(0.5, g.slot - gap)}
                    height={Math.max(0.5, bottom - top)}
                  />
                );
              })}
            </g>
          );
        });
      }}
    </Frame>
  );
}

/** One line per series; missing values break the line instead of dropping to zero. */
export function LineChart({
  data,
  series,
  height = 180,
  format,
  label,
}: {
  data: Point[];
  series: Series[];
  height?: number;
  format: (value: number | null) => string;
  label: string;
}) {
  const values = data.flatMap((point) => series.map((s) => num(point, s.key) ?? 0));
  const yMax = niceMax(Math.max(0, ...values));
  return (
    <Frame
      data={data}
      height={height}
      yMax={yMax}
      formatY={(v) => format(v)}
      label={label}
      tooltip={(point) => <TooltipRows point={point} series={series} format={format} />}
    >
      {(g) => (
        <>
          {g.hover !== null && (
            <line
              className="guide"
              x1={g.x(g.hover) + g.slot / 2}
              x2={g.x(g.hover) + g.slot / 2}
              y1={PAD.top}
              y2={PAD.top + g.innerHeight}
            />
          )}
          {series.map((s) => {
            let d = '';
            let pen = false;
            data.forEach((point, i) => {
              const value = num(point, s.key);
              if (value === null) {
                pen = false;
                return;
              }
              d += `${pen ? 'L' : 'M'}${(g.x(i) + g.slot / 2).toFixed(1)},${g.y(value).toFixed(1)}`;
              pen = true;
            });
            return <path key={s.key} className={`line ${s.className}`} d={d} />;
          })}
          {g.hover !== null &&
            series.map((s) => {
              const value = num(data[g.hover!]!, s.key);
              return value === null ? null : (
                <circle
                  key={s.key}
                  className={`dot ${s.className}`}
                  cx={g.x(g.hover!) + g.slot / 2}
                  cy={g.y(value)}
                  r={3}
                />
              );
            })}
        </>
      )}
    </Frame>
  );
}
