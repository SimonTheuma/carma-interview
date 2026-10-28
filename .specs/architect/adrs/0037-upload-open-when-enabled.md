---
adr: 0037
title: Upload endpoint is open when enabled (no shared token)
status: accepted
date: 2026-10-28
decision-makers: [simon@mavericks.mt]
raw-spec: ../0002-json-file-upload.md
supersedes: 0020
---

# ADR-0037: Upload endpoint is open when enabled

## Context and problem statement
ADR-0020 required a shared bearer token on `POST /api/uploads`. The assignment brief does not require upload authentication. The PoC binds the web port to localhost, and cost abuse is already limited by size, rate, ingest timeouts, enrichment budget, and `UPLOAD_ENABLED`. Keeping an unused token secret and a `token_configured` status field drifted from the running code and README.

## Considered options
1. Re-enforce the shared upload token (ADR-0020)
2. Leave upload open when `UPLOAD_ENABLED` and document the change (chosen)

## Decision outcome
Chosen option 2. `authorizeUpload` succeeds when upload is enabled; missing or leftover `Authorization` / `x-upload-token` headers are ignored. No `upload_token` secret is generated or mounted.

### Consequences
- Good: matches the brief; simpler Compose and Upload UI; no secret for graders to discover.
- Bad: anyone who can reach the port can write and spend budget (mitigated by localhost bind, rate limit, max bytes/items, daily LLM caps, kill switch).
- Risks: if the port is ever exposed beyond localhost without a reverse-proxy auth layer, uploads are open — operators must keep `WEB_BIND=127.0.0.1` or set `UPLOAD_ENABLED=false`.

### Confirmation
Unit tests assert open access when enabled and 503 `upload_disabled` when the kill switch is off. README Upload section states no token is required.
