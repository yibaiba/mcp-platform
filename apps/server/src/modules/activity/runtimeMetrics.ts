import type { ExecutionContext } from '../mcp/executionContext.js';
export const HISTOGRAM_BUCKETS = [
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
  120,
  300,
  Infinity,
] as const;
type CallLabels = { entry: ExecutionContext['entry']; adapter: 'direct' | 'device' | 'pi' };
type Terminal = 'succeeded' | 'tool_error' | 'failed' | 'unknown' | 'cancelled';
type Series = { count: number; sum: number; buckets: number[] };
type Active = {
  labels: CallLabels;
  started: number;
  execution: number;
  resumed?: number;
  cancelled: boolean;
};
const labelText = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(',');
/** Process-local cumulative metrics; no identifiers or caller-provided strings become labels. */
export class RuntimeMetrics {
  private readonly active = new Map<string, Active>();
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, Map<string, Series>>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  begin(id: string, input: { labels: CallLabels; started?: number }) {
    if (this.active.has(id)) throw new Error('Duplicate metric lifecycle');
    this.active.set(id, {
      labels: input.labels,
      started: input.started ?? this.now(),
      execution: 0,
      cancelled: false,
    });
  }
  resume(id: string) {
    const call = this.active.get(id);
    if (call && call.resumed === undefined) call.resumed = this.now();
  }
  pause(id: string) {
    const call = this.active.get(id);
    if (!call || call.resumed === undefined) return;
    call.execution += this.now() - call.resumed;
    call.resumed = undefined;
  }
  cancel(id: string) {
    const call = this.active.get(id);
    if (call) call.cancelled = true;
  }
  finish(id: string, status: Terminal) {
    const call = this.active.get(id);
    if (!call) return;
    this.pause(id);
    this.active.delete(id);
    const labels = labelText({ ...call.labels, status: call.cancelled ? 'cancelled' : status });
    const counter = `platform_calls_total{${labels}}`;
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + 1);
    this.observe(
      'platform_call_total_duration_seconds',
      labels,
      (this.now() - call.started) / 1000,
    );
    this.observe('platform_call_execution_duration_seconds', labels, call.execution / 1000);
  }
  search(input: {
    strategy: 'exact' | 'hnsw';
    status: 'succeeded' | 'failed';
    durationMs: number;
  }) {
    const labels = labelText({ strategy: input.strategy, status: input.status });
    const key = `platform_searches_total{${labels}}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    this.observe('platform_search_duration_seconds', labels, input.durationMs / 1000);
  }
  private observe(name: string, labels: string, value: number) {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new Map();
      this.histograms.set(name, histogram);
    }
    const series = histogram.get(labels) ?? {
      count: 0,
      sum: 0,
      buckets: HISTOGRAM_BUCKETS.map(() => 0),
    };
    series.count++;
    series.sum += value;
    HISTOGRAM_BUCKETS.forEach((bound, index) => {
      if (value <= bound) series.buckets[index] = series.buckets[index]! + 1;
    });
    histogram.set(labels, series);
  }
  render() {
    const lines = [
      '# HELP platform_calls_total Completed logical business calls since process start; cancelled outcomes may be unknown upstream.',
      '# TYPE platform_calls_total counter',
      '# HELP platform_searches_total Semantic searches since process start; separate from business calls.',
      '# TYPE platform_searches_total counter',
      ...[...this.counters].map(([name, value]) => `${name} ${value}`),
      '# HELP platform_active_calls Logical calls still running or waiting for interaction.',
      '# TYPE platform_active_calls gauge',
    ];
    const active = new Map<string, number>();
    for (const entry of ['gateway', 'dashboard', 'pi', 'rest'])
      for (const adapter of ['direct', 'device', 'pi'])
        active.set(labelText({ entry, adapter }), 0);
    for (const call of this.active.values()) {
      const key = labelText(call.labels);
      active.set(key, (active.get(key) ?? 0) + 1);
    }
    for (const [labels, value] of active) lines.push(`platform_active_calls{${labels}} ${value}`);
    for (const [name, series] of this.histograms) lines.push(...this.renderHistogram(name, series));
    return lines;
  }
  private renderHistogram(name: string, series: Map<string, Series>) {
    const lines = [
      `# HELP ${name} Logical elapsed seconds since process start.`,
      `# TYPE ${name} histogram`,
    ];
    for (const [labels, values] of series) {
      HISTOGRAM_BUCKETS.forEach((bound, index) =>
        lines.push(
          `${name}_bucket{${labels},le="${bound === Infinity ? '+Inf' : bound}"} ${values.buckets[index]}`,
        ),
      );
      lines.push(
        `${name}_sum{${labels}} ${values.sum}`,
        `${name}_count{${labels}} ${values.count}`,
      );
    }
    return lines;
  }
}
