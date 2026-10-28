# T8.3 / T8.4 deferred — real-model calibration

Date: 2026-10-24

`OPENAI_MODEL` and provider prices were not set for this implementation pass (plan B1).
Phases 1–8 were completed on the **mock translation path** (ADR-0013).

When keys and prices are available:

1. Set `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_PRICE_*`, optionally `TRANSLATE_MODEL`.
2. Run the 30 labelled pairs per script for validator thresholds (FP-D2/D3).
3. Run the 200-article real-model sample for tokens/cost/storage.
4. Update config defaults for `TRANSLATE_RATIO_*` if needed.
5. Manual FP-9 language-mislabel sample of 50 foreign articles.

Until then, mock-mode verification and kill-switch / budget / search / UI paths are the release bar.
