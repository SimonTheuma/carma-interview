-- app_worker needs DELETE to purge superseded translations (DBA 0003 retention).
-- Rollback: REVOKE DELETE ON article_translations FROM app_worker;

GRANT DELETE ON article_translations TO app_worker;
