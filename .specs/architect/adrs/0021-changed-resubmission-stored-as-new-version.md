---
adr: 0021
title: A re-submitted (source, id) with different text is stored as a new version
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0002-json-file-upload.md
supersedes: null
---

# ADR-0021: A re-submitted (source, id) with different text is stored as a new version

## Context and problem statement
Today `(source, external_id)` conflicts are skipped (`ingest.ts` `ON CONFLICT DO NOTHING`), so a corrected article uploaded again is lost except for a payload hash (data-sanity 0002 F4, U-D3). Uploads make this likely (re-sending a corrected file).

## Considered options
1. Flag and keep the variant payload for review
2. Ignore silently
3. Store as a new version (chosen by the user)

## Decision outcome
Chosen option 3. Identical content (same content hash) remains a plain duplicate. Different content creates a new version of the article; the previous version is kept, not overwritten (append-only, P8). Which version search shows, how enrichment is re-queued, and the schema are to be designed by carma-dba.

### Consequences
- Good: corrections are not lost; full lineage (P3, P8).
- Bad: schema change and a migration; search, status, counts and enrichment must be version-aware; extra LLM spend on changed text (bounded by ADR 0010); beyond ADR 0001 minimal scope.
- Risks: duplicated results in search if versions are not collapsed (FP), enrichment attached to the wrong version.

### Confirmation
DBA spec, tests: re-upload identical (no new version), re-upload changed (new version, old kept, one result in search, new jobs queued).
