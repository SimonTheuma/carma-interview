---
spec: carma-searchability
number: 0004
title: Match rules for non-Latin terms and NOT visibility (delta)
status: draft
date: 2026-10-28
feature: search-and-csp-hardening
inputs: [.specs/architect/0005-search-and-csp-hardening.md, .specs/architect/adrs/0038-script-first-substring-for-non-latin-terms.md, .specs/architect/adrs/0040-keep-not-original-only-and-surface-it.md, .specs/search/0003-english-first-substring-search.md]
principles: [P3, P5, P7]
supersedes: null
---

# 0004 Match rules for non-Latin terms and NOT visibility

## 1. Summary and applicability
Applies. This is a delta to search spec 0003: only the classifier rule for non-Latin terms and the NOT note change. No schema, index, partition or analytical-layer change. Decisions are ADR-0038 and ADR-0040 and are not reopened. Sections of the standard template that do not change (entities, buckets, ranking, dedupe, analytics) are unchanged and not repeated.

## 2. Use cases affected
Ad hoc search only. False-negative cost is high (P3): an analyst quoting a Chinese or Arabic brand word and getting nothing concludes there is no mention. False-positive cost is low: a few extra rows.

## 3. Searchable document
Unchanged: original `search_text`, current translation `search_text`, current summary text (ADR-0035). Substring leaves run `ILIKE` on all three; NOT still runs on the original only (ADR-0040).

## 4. Match rules (the delta)

The mode is chosen from the term's characters first, then from quotes and `*`.

| Term form | Latin script (incl. digits, accents) | Non-Latin script |
| --- | --- | --- |
| Bare word | exact on `simple` vector | substring |
| Quoted single word | exact on `simple` vector | **substring (changed)** |
| Quoted multi-word phrase | `phraseto_tsquery('simple')` | **substring of the whole normalised phrase (changed)** |
| `word*` | prefix OR English stem (ADR-0036) | **substring (changed)**; the `*` adds nothing on unspaced scripts |

Definition of non-Latin: the term has at least one letter and at least one character outside Latin script, digits, punctuation, separators and combining marks (the existing test, [leaf.ts:48-51](../../src/lib/search/leaf.ts)). A mixed Latin/non-Latin term (for example `iPhone苹果`) is non-Latin. A digits-only or punctuation-only term is Latin (exact).

Per script (expected class): Han, Hiragana, Katakana, Hangul, Arabic, Hebrew, Cyrillic, Greek, Devanagari, Thai: substring. Latin with diacritics (`café`): exact. Digits (`2026`): exact.

Known edge to settle in implementation (FP-1): the second regex also matches symbols (`\p{S}`, for example `$`, `€`, `™`, emoji) because they are not in the excluded classes; `$AAPL` would become substring. Recommendation: exclude `\p{S}` from the "non-Latin" test so only letters from other scripts count. Not run.

Normalisation: the term passes through `normaliseText` (NFKC, Arabic harakat/tatweel/alef/ya/taa-marbuta folding, lowercase), the same function that builds `search_text` ([normalise/index.ts](../../src/lib/normalise/index.ts)), so index and query agree. `escapeIlike` is applied after normalisation. For a phrase, internal whitespace is collapsed to single spaces before matching, because the index text is stored with single spaces between headline and body only, and source text with other spacing would otherwise miss (FP-2).

Verified facts that motivate the rule (scratch PostgreSQL 16.3, 2026-10-28): see architect spec 0005 section 3.

## 5. 1-2 character terms and trigram use
`pg_trgm` produces trigrams from 3-character windows with padding; one- and two-character terms cannot use the GIN trigram index effectively and fall back to a scan of the filtered set. Many Chinese words are two characters. Rule: allow them (recall first, P3) and rely on the 2 second statement timeout and the existing 503 note; do not add a minimum length. Revisit with a measurement if the corpus grows (HP-2).

## 6. Echo and notes
- Parsed-query echo ([echo.ts](../../src/lib/search/echo.ts)) renders quotes exactly as typed and makes no "exact" claim, so no change.
- Non-Latin note (existing, [run.ts:276-280](../../src/lib/search/run.ts)): change the trigger from "the raw query contains non-Latin letters" to "at least one leaf was classified substring", and word it "Terms in Chinese, Arabic and similar scripts match any text containing them, including inside longer words, in the original and the translation." Quotes and `*` on those terms make no difference, and the note says so.
- NOT note (ADR-0040): show it directly under the "Interpreted as" line ([SearchPage.tsx:296](../../src/components/search/SearchPage.tsx)) instead of in the muted notes list, using the existing text: "NOT terms exclude articles by their original text only." Keep it in `echo_notes` for API users. Add the same sentence to the README search section.
- Coverage unaffected (no new gap; no new signal).

## 7. Golden cases

| ID | Query | Expected |
| --- | --- | --- |
| G18 | `"人工智能"` | article 9 |
| G19 | `人工智能` (bare) | article 9 |
| G20 | `科技*` | article 9 |
| G21 | `"人工智能 云计算"` | none (the sample text has 和 between the words); `"人工智能和云计算"` returns article 9 |
| G22 | `"عقارات"` | article 8 |
| G23 | `عقارات*` | article 8 |
| G24 | `"oil prices"`, `renew*`, `"startup"` | unchanged from search spec 0003 (regression) |
| G25 | `"能源" AND NOT 中国` | none from sample (article 9 excluded by original text); documents NOT on the original |
| G26 | A translated foreign article whose English translation contains `coal`, query `energy AND NOT coal` | article is returned (ADR-0040), and the NOT note is visible |
| G27 | `$AAPL`, `2026`, `café` | classified exact (script table test) |

## 8. Risks and hot paths
| ID | Failure point | Effect | Detection |
| --- | --- | --- | --- |
| FP-S1 | Symbol-only non-Latin test (`$`, emoji) sends Latin terms to substring | Noisy matches, scans | Script table (G27) |
| FP-S2 | Phrase spacing differs from stored text | Phrase misses | G21, integration test on the real article text |
| FP-S3 | Note trigger still keys on the raw query | Note missing or wrong | Unit test on notes |
| HP-S1 | Short substring scans | Slow search at scale | `EXPLAIN` on 20 articles now; larger seed later |

## 9. Handoff
- carma-backend-testing: script table over the classifier, G18-G27, note triggers, NOT note visibility, regression of Latin cases.
- carma-telemetry (not run by choice): `mss_search_duration_seconds` already labels `nonlatin_sub`; no change.
- carma-ux (not run by choice): the NOT note move in section 6 is the only UI change.
- carma-dba (not run): no change expected.

## 10. Decisions needed and open questions
- None blocking. `UNCONFIRMED`: excluding `\p{S}` from the non-Latin test (section 4 recommendation) is a default, not a user decision; it narrows ADR-0038 only for symbols.
- Summaries are assumed English, so non-Latin terms rarely match summaries.
