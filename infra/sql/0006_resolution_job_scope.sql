CREATE OR REPLACE FUNCTION ingestion.enqueue_event_resolution_job()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('COMPLETED', 'PARTIAL')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND EXISTS (
       SELECT 1 FROM ingestion.raw_document d
       WHERE d.crawl_run_id = NEW.id
     )
     AND EXISTS (
       SELECT 1 FROM ingestion.source s
       WHERE s.id = NEW.source_id AND s.connector_key <> 'animecons'
     ) THEN
    INSERT INTO ingestion.job(
      job_type, required_capability, status, priority, dedupe_key, payload,
      source_id, crawl_run_id, available_at, not_before, max_attempts
    ) VALUES (
      'EVENT_RESOLUTION', 'EVENT_RESOLUTION_V1', 'QUEUED', 'NORMAL',
      'event-resolution:run:' || NEW.id::text,
      jsonb_build_object(
        'crawlRunId', NEW.id,
        'sourceId', NEW.source_id,
        'knownEventId', NEW.root_event_id
      ),
      NEW.source_id, NEW.id, now(), now(), 4
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- AnimeCons is a directory connector: one run may contain many independent
-- events and its deterministic connector already materializes those events.
-- It must not be collapsed into one event-level Candidate.
DELETE FROM ingestion.job j
USING ingestion.source s
WHERE j.source_id = s.id
  AND s.connector_key = 'animecons'
  AND j.job_type = 'EVENT_RESOLUTION'
  AND j.status IN ('QUEUED', 'RETRY_WAIT')
  AND NOT EXISTS (SELECT 1 FROM ingestion.candidate c WHERE c.job_id = j.id);
