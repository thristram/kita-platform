-- Resolution must represent the final crawl snapshot. A crawl can briefly
-- transition to COMPLETED while another crawler transaction is still
-- publishing newly discovered work, so verify crawler-job quiescence in the
-- trigger and key resolution jobs by the final document count.

CREATE OR REPLACE FUNCTION ingestion.enqueue_event_resolution_job()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  document_count integer;
BEGIN
  IF NEW.status IN ('COMPLETED', 'PARTIAL')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND EXISTS (
       SELECT 1 FROM ingestion.source s
       WHERE s.id = NEW.source_id AND s.connector_key <> 'animecons'
     )
     AND NOT EXISTS (
       SELECT 1 FROM ingestion.job j
       WHERE j.crawl_run_id = NEW.id
         AND j.job_type IN ('URL_FETCH', 'MEDIA_FETCH')
         AND j.status IN ('QUEUED', 'RETRY_WAIT', 'LEASED', 'RUNNING')
     ) THEN
    SELECT count(*)::integer INTO document_count
    FROM ingestion.raw_document d
    WHERE d.crawl_run_id = NEW.id;

    IF document_count > 0 THEN
      INSERT INTO ingestion.job(
        job_type, required_capability, status, priority, dedupe_key, payload,
        source_id, crawl_run_id, available_at, not_before, max_attempts
      ) VALUES (
        'EVENT_RESOLUTION', 'EVENT_RESOLUTION_V1', 'QUEUED', 'NORMAL',
        'event-resolution:v2:run:' || NEW.id::text || ':documents:' || document_count::text,
        jsonb_build_object(
          'crawlRunId', NEW.id,
          'sourceId', NEW.source_id,
          'knownEventId', NEW.root_event_id,
          'documentCount', document_count
        ),
        NEW.source_id, NEW.id, now(), now(), 4
      )
      ON CONFLICT (dedupe_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
