/** A tiny bar chart of counts over time, for tables. */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label: string;
}) {
  const max = Math.max(1, ...values);
  const slot = values.length > 0 ? width / values.length : width;
  return (
    <svg className="sparkline" width={width} height={height} role="img" aria-label={label}>
      <line className="sparkline-base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
      {values.map((v, i) =>
        v > 0 ? (
          <rect
            key={i}
            x={i * slot + 0.5}
            y={height - Math.max(1.5, (v / max) * (height - 2))}
            width={Math.max(1, slot - 1)}
            height={Math.max(1.5, (v / max) * (height - 2))}
          />
        ) : null,
      )}
    </svg>
  );
}
