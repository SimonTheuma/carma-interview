type Coverage = {
  articles_matching_base_filters: number;
  articles_in_scope: number;
  corpus_articles: number;
  enriched_sentiment: number;
  enriched_topics: number;
  watermark: { published_at: string | null; ingested_at: string | null };
};

export function CoverageLine({ coverage }: { coverage: Coverage }) {
  const partial =
    coverage.corpus_articles > 0 && coverage.enriched_sentiment < coverage.corpus_articles;
  const watermark = coverage.watermark.published_at
    ? new Date(coverage.watermark.published_at).toISOString().replace("T", " ").slice(0, 16)
    : "—";
  return (
    <p className={`text-sm ${partial ? "text-warn" : "text-muted"}`}>
      {coverage.articles_in_scope} articles in scope · corpus {coverage.enriched_sentiment} with
      sentiment · {coverage.enriched_topics} with topics · data up to {watermark} UTC
    </p>
  );
}
