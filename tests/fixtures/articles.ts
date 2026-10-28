export function sampleArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: "art-1",
    source: "fixture",
    published_at: "2026-07-14T10:00:00.000Z",
    language: "en",
    headline: "Oil prices rise amid supply concerns",
    body: "Markets reacted to geopolitical tensions and supply chain disruption.",
    ...overrides,
  };
}

/** Planted rows for Amendment B golden cases (search 0003 G1–G12). */
export const searchMatchFixtures = {
  startupSingular: {
    externalId: "g-startup-en",
    language: "en",
    headline: "Funding round",
    body: "A new startup raised funds this week.",
  },
  startupsPlural: {
    externalId: "g-startups-case",
    language: "en",
    headline: "Startups boom",
    body: "Startups are thriving in the region.",
  },
  renewableEn: {
    externalId: "g-renewable",
    language: "en",
    headline: "Energy",
    body: "The renewable energy sector grew quickly.",
  },
  renewablesEn: {
    externalId: "g-renewables",
    language: "en",
    headline: "Portfolio",
    body: "Investors favour renewables this quarter.",
  },
  renewedEn: {
    externalId: "g-renewed",
    language: "en",
    headline: "Contract",
    body: "The firm renewed its licence yesterday.",
  },
  nonrenewableEn: {
    externalId: "g-nonrenewable",
    language: "en",
    headline: "Fuels",
    body: "Demand for nonrenewable fuels remains high.",
  },
  mediaIntelligence: {
    externalId: "g-media-intel",
    language: "en",
    headline: "Brief",
    body: "Our media intelligence desk tracked the story.",
  },
  catsAndDogs: {
    externalId: "g-cats-and-dogs",
    language: "en",
    headline: "Pets",
    body: "The story mentions cats and dogs together.",
  },
  nestA: {
    externalId: "g-nest-a",
    language: "en",
    headline: "Nest A",
    body: "alpha beta gamma tokens for nesting.",
  },
  frenchEntreprises: {
    externalId: "g-fr-entreprises",
    language: "fr",
    headline: "Les entreprises",
    body: "Les grandes entreprises annoncent des résultats.",
  },
  arabicWithStartup: {
    externalId: "g-ar-startup-loanword",
    language: "ar",
    headline: "أخبار",
    body: "قالت مصادر إن startups نمت بسرعة في المنطقة.",
  },
  chineseTerm: {
    externalId: "g-zh",
    language: "zh",
    headline: "新闻",
    body: "市场关注房地产政策变化。",
  },
  undEnglish: {
    externalId: "g-und-en",
    language: "und",
    headline: "Unknown label",
    body: "A new startup opened an office.",
  },
  enGb: {
    externalId: "g-en-gb",
    language: "en-GB",
    headline: "British news",
    body: "A new startup raised capital in London.",
  },
  summaryOnly: {
    externalId: "g-summary-only",
    language: "en",
    headline: "Quiet headline",
    body: "Nothing notable in the body text here.",
    summary: "Exclusive mention of xenonwidget in this summary only.",
  },
  thePrefixBody: {
    externalId: "g-the-prefix",
    language: "en",
    headline: "Theatre",
    body: "The theatre opened with a new season.",
  },
  metaChars: {
    externalId: "g-meta",
    language: "en",
    headline: "Literal",
    body: "Contains 100%_complete\\path and o'clock tokens.",
  },
};

/** Inflection vocabulary for bulk seed / benchmarks. */
export const INFLECTION_PAIRS = [
  ["startup", "startups"],
  ["enterprise", "enterprises"],
  ["news", "news"],
] as const;
