-- Cache writes use ON CONFLICT DO UPDATE; needs UPDATE on translation_chunk_cache.
-- Rollback: REVOKE UPDATE ON translation_chunk_cache FROM app_worker;

GRANT UPDATE ON translation_chunk_cache TO app_worker;
