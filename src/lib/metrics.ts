type Labels = Record<string, string>;

type Counter = { name: string; help: string; values: Map<string, number> };
type Gauge = { name: string; help: string; values: Map<string, number> };
type Histogram = {
  name: string;
  help: string;
  buckets: number[];
  values: Map<string, { counts: number[]; sum: number }>;
};

const ALLOWED_LABEL_KEYS = new Set([
  "provider",
  "part",
  "outcome",
  "state",
  "method",
  "code",
  "origin",
  "reason",
  "route",
  "status_class",
  "pool",
  "query",
  "kind",
  "phase",
  "batch_kind",
  "script",
  "view",
]);

/** Exported for catalogue tests. */
export const METRIC_ALLOWED_LABEL_KEYS = ALLOWED_LABEL_KEYS;

function labelKey(labels: Labels): string {
  for (const k of Object.keys(labels)) {
    if (!ALLOWED_LABEL_KEYS.has(k)) {
      throw new Error(`metric label not allowed: ${k}`);
    }
  }
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]?.replace(/"/g, '\\"') ?? ""}"`)
    .join(",");
}

type Registry = {
  counters: Map<string, Counter>;
  gauges: Map<string, Gauge>;
  histograms: Map<string, Histogram>;
};

const g = globalThis as typeof globalThis & { __mssMetrics?: Registry };

function registry(): Registry {
  if (!g.__mssMetrics) {
    g.__mssMetrics = {
      counters: new Map(),
      gauges: new Map(),
      histograms: new Map(),
    };
  }
  return g.__mssMetrics;
}

export function counter(name: string, help: string): {
  inc(labels?: Labels, by?: number): void;
} {
  const reg = registry();
  if (!reg.counters.has(name)) {
    reg.counters.set(name, { name, help, values: new Map() });
  }
  const c = reg.counters.get(name)!;
  return {
    inc(labels: Labels = {}, by = 1) {
      const key = labelKey(labels);
      c.values.set(key, (c.values.get(key) ?? 0) + by);
    },
  };
}

export function gauge(name: string, help: string): {
  set(labels: Labels, value: number): void;
} {
  const reg = registry();
  if (!reg.gauges.has(name)) {
    reg.gauges.set(name, { name, help, values: new Map() });
  }
  const ga = reg.gauges.get(name)!;
  return {
    set(labels: Labels, value: number) {
      ga.values.set(labelKey(labels), value);
    },
  };
}

export function histogram(
  name: string,
  help: string,
  buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
): {
  observe(labels: Labels, seconds: number): void;
} {
  const reg = registry();
  if (!reg.histograms.has(name)) {
    reg.histograms.set(name, { name, help, buckets, values: new Map() });
  }
  const h = reg.histograms.get(name)!;
  return {
    observe(labels: Labels, seconds: number) {
      const key = labelKey(labels);
      let entry = h.values.get(key);
      if (!entry) {
        entry = { counts: h.buckets.map(() => 0), sum: 0 };
        h.values.set(key, entry);
      }
      entry.sum += seconds;
      for (let i = 0; i < h.buckets.length; i++) {
        const b = h.buckets[i];
        if (b !== undefined && seconds <= b) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
      }
    },
  };
}

export function renderPrometheus(): string {
  const reg = registry();
  const lines: string[] = [];
  lines.push("# HELP mss_build_info Build information");
  lines.push("# TYPE mss_build_info gauge");
  lines.push(`mss_build_info{version="0.1.0"} 1`);

  for (const c of reg.counters.values()) {
    lines.push(`# HELP ${c.name} ${c.help}`);
    lines.push(`# TYPE ${c.name} counter`);
    for (const [k, v] of c.values) {
      lines.push(`${c.name}${k ? `{${k}}` : ""} ${v}`);
    }
  }
  for (const ga of reg.gauges.values()) {
    lines.push(`# HELP ${ga.name} ${ga.help}`);
    lines.push(`# TYPE ${ga.name} gauge`);
    for (const [k, v] of ga.values) {
      lines.push(`${ga.name}${k ? `{${k}}` : ""} ${v}`);
    }
  }
  for (const h of reg.histograms.values()) {
    lines.push(`# HELP ${h.name} ${h.help}`);
    lines.push(`# TYPE ${h.name} histogram`);
    for (const [k, entry] of h.values) {
      let acc = 0;
      for (let i = 0; i < h.buckets.length; i++) {
        acc += entry.counts[i] ?? 0;
        const labels = k ? `${k},le="${h.buckets[i]}"` : `le="${h.buckets[i]}"`;
        lines.push(`${h.name}_bucket{${labels}} ${acc}`);
      }
      const infLabels = k ? `${k},le="+Inf"` : `le="+Inf"`;
      lines.push(`${h.name}_bucket{${infLabels}} ${acc}`);
      lines.push(`${h.name}_sum${k ? `{${k}}` : ""} ${entry.sum}`);
      lines.push(`${h.name}_count${k ? `{${k}}` : ""} ${acc}`);
    }
  }
  return lines.join("\n") + "\n";
}
