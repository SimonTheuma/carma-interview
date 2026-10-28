export type SearchFilters = {
  from?: Date | undefined;
  to?: Date | undefined;
  sources?: string[] | undefined;
  languages?: string[] | undefined;
  sentiments?: string[] | undefined;
  topics?: string[] | undefined;
};

export type FilterBuild = {
  clauses: string[];
  params: unknown[];
  nextIndex: number;
};

/** Parse date-only YYYY-MM-DD as 00:00:00Z; `to` is exclusive. */
export function parseDateParam(value: string | null | undefined, edge: "from" | "to"): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

export function buildFilterClauses(
  filters: SearchFilters,
  startIndex: number,
): FilterBuild {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;

  if (filters.from) {
    clauses.push(`a.published_at >= $${i}`);
    params.push(filters.from.toISOString());
    i++;
  }
  if (filters.to) {
    clauses.push(`a.published_at < $${i}`);
    params.push(filters.to.toISOString());
    i++;
  }
  if (filters.sources && filters.sources.length > 0) {
    clauses.push(`a.source = ANY($${i}::text[])`);
    params.push(filters.sources);
    i++;
  }
  if (filters.languages && filters.languages.length > 0) {
    clauses.push(`a.language = ANY($${i}::text[])`);
    params.push(filters.languages);
    i++;
  }

  if (filters.sentiments && filters.sentiments.length > 0) {
    const hasNot = filters.sentiments.includes("not_enriched");
    const values = filters.sentiments.filter((s) => s !== "not_enriched");
    const parts: string[] = [];
    if (values.length) {
      parts.push(`EXISTS (
        SELECT 1 FROM derived_values d
        WHERE d.article_id = a.id AND d.field = 'sentiment' AND d.is_current
          AND d.value = ANY($${i}::text[])
      )`);
      params.push(values);
      i++;
    }
    if (hasNot) {
      parts.push(`NOT EXISTS (
        SELECT 1 FROM derived_values d
        WHERE d.article_id = a.id AND d.field = 'sentiment' AND d.is_current
      )`);
    }
    if (parts.length) clauses.push(`(${parts.join(" OR ")})`);
  }

  if (filters.topics && filters.topics.length > 0) {
    const hasNot = filters.topics.includes("not_enriched");
    const values = filters.topics.filter((t) => t !== "not_enriched");
    const parts: string[] = [];
    if (values.length) {
      parts.push(`EXISTS (
        SELECT 1 FROM derived_values d
        WHERE d.article_id = a.id AND d.field = 'topic' AND d.is_current
          AND d.value = ANY($${i}::text[])
      )`);
      params.push(values);
      i++;
    }
    if (hasNot) {
      parts.push(`NOT EXISTS (
        SELECT 1 FROM derived_values d
        WHERE d.article_id = a.id AND d.field = 'topic' AND d.is_current
      )`);
    }
    if (parts.length) clauses.push(`(${parts.join(" OR ")})`);
  }

  return { clauses, params, nextIndex: i };
}

export function baseFiltersOnly(filters: SearchFilters): SearchFilters {
  const out: SearchFilters = {};
  if (filters.from) out.from = filters.from;
  if (filters.to) out.to = filters.to;
  if (filters.sources) out.sources = filters.sources;
  if (filters.languages) out.languages = filters.languages;
  return out;
}
