import { chartNumber, type RotationChart as Chart } from '../server/rotation-chart.ts';

export function RotationChart({ chart }: { chart: Chart }) {
  const max = Math.max(...chart.points.map((point) => point.value)) || 1;
  return (
    <figure className="rotation-chart" aria-label={chart.title}>
      <figcaption>{chart.title}</figcaption>
      <p className="rotation-chart-context">
        {chart.period} · {chart.metric}（{chart.unit}）
      </p>
      <ol className="rotation-chart-bars">
        {chart.points.map((point) => (
          <li key={point.label}>
            <span className="rotation-chart-label">{point.label}</span>
            <span className="rotation-chart-track" aria-hidden="true">
              <span style={{ width: `${(point.value / max) * 100}%` }} />
            </span>
            <span className="rotation-chart-value">{chartNumber(point.value)}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
