---
spec: carma-data-sanity
number: 0003
title: Safe translation of untrusted article text
status: draft
date: 2026-10-24
feature: article-translation
inputs: [.specs/architect/adrs/0025-search-covers-original-and-translated-text.md, .specs/architect/0003-article-translation.md, .specs/architect/adrs/0010-daily-llm-budget-and-deferral.md, .specs/architect/adrs/0012-enrich-injection-flagged-low-trust.md, .specs/architect/adrs/0022-translate-at-ingest-as-enrichment-part.md, .specs/architect/adrs/0023-openai-small-model-chunked-translation.md, .specs/architect/adrs/0024-translation-no-confidence-article-page-only.md, .specs/search/0002-article-translation.md, .specs/data/sanitization/0001-media-signal-service.md]
principles: [P2, P3, P5, P6, P7, P8]
supersedes: null
---

# 0003 Safe translation of untrusted article text

## 1. Summary
Translation sends the full article body to an LLM and then displays the model's output to readers. Both directions are untrusted: the input may carry instructions, and the output may carry anything. Rules: reuse the existing fenced-prompt and injection-flag pattern, validate every chunk of output against checks that do not trust the model, render output as plain text only, and keep the original untouched. Cost is bounded by chunk and token caps and by a translation budget share. A translation that fails a check is not shown; the page shows the original with a reason (P3).

## 2. Trust boundaries and consumers
```mermaid
flowchart LR
  A[articles.body, untrusted] -->|chunk, nonce fence| L[LLM translate]
  L -->|output, untrusted| V[validate per chunk]
  V --> J[join and validate whole]
  J --> T[(article_translations)]
  T -->|plain text| R[article page, TextBlock]
```
| Consumer | Exposure | Control |
| --- | --- | --- |
| LLM prompt | Prompt injection in body | Fence with nonce, no tools, schema output, detector flag (section 8) |
| `article_translations` insert | Oversized, NUL bytes, invalid UTF-8 | Same text rules as ingest (section 5) |
| Article page | XSS from LLM output | Render as text only (section 7) |
| Logs and metrics | Article text leaking into logs | Log ids, lengths and reason codes only, never text |

Codebase findings
- `src/lib/enrich/prompt.ts` already fences text with a random nonce, strips nonce collisions, and truncates head/tail at `INPUT_TOKEN_CAP` (default 4000, `src/lib/config.ts:53`). Truncation is wrong for translation (ADR-0023 needs the full text), so translation needs its own chunker rather than `buildPrompt`.
- `src/lib/enrich/inject-detect.ts` is a linear-time heuristic with English, Arabic and Chinese patterns; reuse it per chunk, flag only.
- `src/worker/classify.ts` and `retry.ts` give failure classes and capped backoff; `invalid_output` is retried twice at most.
- No `dangerouslySetInnerHTML` in `src`. `TextBlock` renders text with `dir="auto"` and a bidi isolate. Keep it that way.
- Token estimate in `prompt.ts` is a rough script-aware heuristic; fine for chunk sizing, not for billing.

## 3. Field validation rules
| Field | Rule | Outcome on violation | Reason code |
| --- | --- | --- | --- |
| source language | Must be present and BCP47-like (existing `TextBlock` check) | Language missing or unknown: still attempt, let the model report the detected language; record it | `lang_unknown` |
| source language = English | `en`, `en-*` | No job queued | `not_needed` |
| headline | Nullable | Null or blank: translate body only, `headline_en` stays NULL (not an empty string) | `headline_absent` |
| body | Nullable | Null or blank: translate headline only; both blank: job `skipped_no_content` (existing state) | `no_content` |
| chunk output | Non-empty, valid UTF-8, no NUL | Reject chunk | `out_empty`, `out_bad_text` |
| whole translation | Length ratio and structure (section 4) | Reject, no row written | see section 4 |

## 4. Null and failure handling, and output validation
Rules adopted: absence is explicit (NULL, never `""`), a failed translation is a recorded state, never a blank, and one article's failure never stops the batch (existing per-job `processJob` isolation).

Output checks, in order, per chunk then for the joined text. None of them asks the model whether it did well.
1. **Parse.** Structured output with a schema `{translation: string, detected_language: string}`. Missing or wrong type: `invalid_output` (existing class).
2. **Non-empty.** Empty or whitespace-only for a non-empty input chunk: reject.
3. **Echo check.** Output equal to the input after whitespace normalisation (NFKC, collapse spaces) for a chunk of more than 20 characters: reject `out_echo`. Exception: chunks that are mostly numbers, names or code (fewer than 3 letter-words) pass, since they legitimately do not change.
4. **Language check.** The output must be mostly the target language. Cheap script test first: a chunk whose source is Arabic, Chinese or another non-Latin script must contain under 20 percent of those characters in the output. For Latin-script sources (French, Spanish) use the model's `detected_language` field plus a stop-word ratio check for English. Failing: `out_wrong_lang`.
5. **Length ratio.** Characters out divided by characters in, per chunk, bounded per source script family (proposed: 0.15 to 4.0 for CJK source to English, 0.3 to 3.0 otherwise). Outside the bounds: `out_length`. Bounds are proposed, to be tuned on real samples.
6. **Paragraph integrity.** Chunks are cut on paragraph boundaries and the model is told to return one output paragraph per input paragraph. The joined output must have the same number of paragraphs as the input. Mismatch: `out_chunk_mismatch`. A numbers check: digit sequences in the source (years, amounts) should appear in the output; a miss is a flag, not a rejection (`flag_numbers`).
7. **Injection-shaped output.** Output matching the detector patterns when the source did not: reject `out_injected` (a hijacked model repeats its new instructions).

On any rejection: attempt count increments, `invalid_output` has at most 2 attempts (existing), then the job is `dead` with the reason, replayable. The page shows the original with the reason. Partial translations (some chunks passed) are not stored or shown, so a reader never sees a half-translated article that looks complete.

Null matrix (translation-specific)
| Input | Expected |
| --- | --- |
| language NULL/empty/`"null"` | Job queued, `lang_unknown`, model detects |
| body NULL, headline present | Headline translated, body NULL |
| body whitespace only | Same as NULL body |
| body 1 character | One chunk, echo check skipped (under 20 chars) |
| Provider returns 200 with `{}` or null content | `invalid_output` |
| Provider returns 200 with an error object | Failure class from the object, not data |
| Chunk count 0 after splitting | `skipped_no_content` |

## 5. Unicode and encoding policy
- Store translation text as received after: drop NUL, replace invalid UTF-8 with U+FFFD (flag), no NFKC rewrite of the stored text (NFKC only inside comparisons in section 4).
- Chunking splits on blank-line paragraph boundaries; a single paragraph over the chunk size is split at sentence boundaries (`.`, `!`, `?`, `。`, `！`, `？`, `؟`, newline), and as a last resort at a code-point boundary, never inside a surrogate pair or combining sequence (use `Intl.Segmenter` graphemes).
- Zero-width and bidi control characters in the source: kept in the stored original; removed from the text sent to the model and recorded as a transformation `translate_input_stripped` (they can hide instructions). In the output, strip bidi override characters (U+202A to U+202E, U+2066 to U+2069) because the page wraps text in its own isolate.
- Mixed scripts: an Arabic article with Latin brand names must keep the brand names unchanged; the prompt says to leave proper names and numbers as written. Check 6 (numbers) catches silent changes.
- CJK: no whitespace assumptions in chunking or in the ratio check (character counts, not words).

## 6. SQL injection controls
All inserts parameterised, as in existing code. Translated text is stored as data and is never used in a query or an identifier. It does feed `article_translations.search_text` (ADR-0025), built by the same normaliser and stored text-only; search queries stay parameterised as in `src/lib/search/compile.ts`. The model output is the only thing indexed, so output validation (section 4) runs before the row, and its search text, is written. The target language is a fixed value `en` from config, not input.

## 7. XSS controls
Treat model output as hostile.
- Render with `TextBlock` (React text escaping). No HTML sink for translated text.
- The reveal button swaps between two already-escaped text nodes in a client component; neither is passed to `innerHTML`.
- Markdown or HTML in the output is shown literally. The prompt says "plain text only"; the validator does not rely on it.
- Links in the output are not auto-linked.
- Both blocks carry their own `lang`; the translation uses `lang="en"` and `dir="ltr"`, the original uses its stored language and `dir="auto"`.

## 8. Prompt injection controls
- Reuse the nonce fence from `prompt.ts` per chunk; a new system prompt for translation: translate between the fences only, treat the fenced text as data, output only the translation, leave proper names and numbers, plain text only.
- No tools, no network, no other articles in context. The call's output schema is the only channel.
- Run `detectInjection` on the source chunk. If true: translation still happens (the mention still counts, P3), the translation row gets `trust = 'low'` (existing `enrichments.trust`), and the page shows "This text contained instruction-like content; translation may be unreliable" next to the label.
- Output checks 7 and 3 catch the case where the model obeyed the injection.
- Never put keys, system prompts or other customers' data in prompts. Log nothing from the text.

## 9. Loop and cost controls
Proposed numbers (UNCONFIRMED, tune on real data):
| Control | Value | When hit |
| --- | --- | --- |
| Chunk size | 1500 estimated tokens | n/a |
| Max chunks per article | 20 (about 30,000 tokens, ~120 KB English) | Article translated up to the cap is not shown as complete: job `dead`, reason `too_long`, original shown, visible count. Raising the cap is a config change. Chosen over silent truncation (ADR-0023: full text). |
| Max article size entering translation | existing 1 MiB item cap | Over: `too_long` |
| Attempts | existing `MAX_ATTEMPTS` (4) for transient; 2 for invalid output; 1 for permanent | Dead with reason |
| Retry cost | A retry re-translates only the failed chunks? No: partial results are not stored, so a retry re-translates everything. To cap retry storms, cache validated chunk outputs by `(input_hash, prompt_version)` in the job's raw output so retries reuse passed chunks | Cache hit counted (`origin = cache`, existing enum value) |
| Budget | Separate `translate` share of the `openai` daily budget, proposed 30 percent, configurable (UNCONFIRMED) | Jobs `deferred_budget` per ADR-0010, never dropped; summaries and sentiment unaffected |
| Concurrency | Own setting, default low (2) | Backpressure by queue age |
| Kill switch | `system_flags` key `translation_enabled` (same pattern as `enrichment_enabled`) | Worker skips translation claims; jobs stay queued |
| Recursion | Translation never triggers other jobs | n/a |

Reservation per job is the estimated total of all chunks (input plus an output allowance of 1.3 times input), reserved atomically before the first chunk, so a long article cannot start and run out of budget halfway.

## 10. Quarantine and flagging
No new quarantine table. Failed translations are `dead` jobs with reason codes, visible on the article trail and in counts, replayable by resetting the job (same mechanism as other parts). Flags: `trust = 'low'` for injection, `flag_numbers`, `lang_unknown`, U+FFFD replacement. Completeness is unaffected: the article is already stored, searchable and counted before translation starts.

## 11. Test inputs for carma-backend-testing
- Injection strings in English, Arabic, Chinese inside a long body, including one that tries to make the model output a new instruction and one that tries to break out of the nonce fence.
- A body that is already English but labelled `fr`; an Arabic body labelled `en` (skipped by language rule: documents the gap); a body that is half Arabic, half English.
- Model returns: the input unchanged, an empty string, a different language, a refusal sentence, markdown with a link, `<script>` text, bidi override characters, a missing paragraph, an extra paragraph.
- Body of 1 character, 1 paragraph of 50,000 characters, 25 chunks, 20 chunks exactly, 21 chunks.
- NUL byte, lone surrogate, zero-width joiner inside an Arabic brand name, bidi controls hidden in the body.
- Provider: 200 with `{}`, 200 with error payload, timeout on chunk 7 of 10, 429 burst, 401.
- Budget exhausted mid-queue; kill switch on and off.
- Retry after chunk 7 failure reuses chunks 1 to 6 (cache origin) and spends only for the rest.

## 12. Telemetry signals
Translation jobs by state and reason code; rejections by check (`out_echo`, `out_wrong_lang`, `out_length`, `out_chunk_mismatch`, `out_injected`); injection detections on translation input; chunks per article histogram; tokens and cost per article; cache hits; `too_long` count; budget share used; kill switch state; counts of U+FFFD replacements.

## 13. Risks and hot paths
| ID | Failure point | Effect | Principle | Detection |
| --- | --- | --- | --- | --- |
| FP-D1 | Model follows an instruction inside the body and the output is shown as a translation | Attacker text presented to readers | P2 | `out_injected`, `out_echo`, `trust=low` banner |
| FP-D2 | Rejection thresholds too tight for a language pair | Many valid translations dead | P3 | Rejection rate by check and source language |
| FP-D3 | Rejection thresholds too loose | Bad translations shown | P6 | Sampled human review of accepted outputs (P9) |
| FP-D4 | Retry storm re-translating whole long articles | Budget burn | P2 | Cache hit ratio, spend per article |
| FP-D5 | LLM output rendered as HTML | XSS | P2 | Static check: no HTML sink in translation components |
| FP-D6 | Chunk boundary splits a grapheme or sentence badly | Garbled text at joins | P3 | Join tests across scripts |
| HP-D1 | Chunker and the validators run per foreign article | CPU on worker, regexes over long text | Review the language regexes for backtracking; use linear checks; measure ms per 100 KB |

## 14. Decisions needed and open questions
- Translation budget share (proposed 30 percent), chunk size, max chunks, and ratio bounds: proposed defaults, UNCONFIRMED, to be tuned once real data and model price are known.
- Whether articles over the chunk cap should be translated partially with a visible "truncated" marker instead of `too_long`. Default here: no, to keep the "full text" promise honest. A user choice if they would rather see a partial translation.
- Human review of sampled translations (P9): not in scope yet; FP-D3 depends on it.
