# JSON file upload measurements

Recorded during plan 0002 implementation (phase 2 / HP placeholders).

| ID | Metric | Value | Notes |
| --- | --- | --- | --- |
| HP-1 | 1000-item upload items/s | deferred | Run against Compose with mock enrichment; fill after smoke |
| HP-2 | Peak RSS at 5 MiB cap | deferred | Target under 80% of 512m web mem_limit |
| HP-D1 | Event-loop lag during upload | sampler wired (`mss_event_loop_lag_seconds`) | Observe during load |
| Spike | Next body buffering | confirmed | App Router buffers; enforce via Content-Length + byte-count reader (devops 0002 §13) |

Defaults locked: 5 MiB / 1000 items / depth 8 / 10 uploads·h⁻¹ / 60 s deadline / pool 10s·15s·5s.
