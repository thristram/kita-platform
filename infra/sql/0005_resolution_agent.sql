ALTER TABLE ingestion.job
  ADD COLUMN IF NOT EXISTS lease_token_hash text,
  ADD COLUMN IF NOT EXISTS result_payload jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS candidate_job_unique
  ON ingestion.candidate(job_id)
  WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingestion.candidate_evidence (
  candidate_id uuid NOT NULL REFERENCES ingestion.candidate(id) ON DELETE CASCADE,
  raw_document_id uuid NOT NULL REFERENCES ingestion.raw_document(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(candidate_id, raw_document_id)
);

CREATE INDEX IF NOT EXISTS candidate_evidence_document
  ON ingestion.candidate_evidence(raw_document_id);

CREATE INDEX IF NOT EXISTS resolution_job_lease_queue
  ON ingestion.job(status, not_before, priority, created_at)
  WHERE job_type = 'EVENT_RESOLUTION';

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

DROP TRIGGER IF EXISTS crawl_run_enqueue_event_resolution ON ingestion.crawl_run;
CREATE TRIGGER crawl_run_enqueue_event_resolution
AFTER UPDATE OF status ON ingestion.crawl_run
FOR EACH ROW EXECUTE FUNCTION ingestion.enqueue_event_resolution_job();

-- Backfill finished runs so installing this migration does not require re-crawling.
INSERT INTO ingestion.job(
  job_type, required_capability, status, priority, dedupe_key, payload,
  source_id, crawl_run_id, available_at, not_before, max_attempts
)
SELECT
  'EVENT_RESOLUTION', 'EVENT_RESOLUTION_V1', 'QUEUED', 'NORMAL',
  'event-resolution:run:' || r.id::text,
  jsonb_build_object('crawlRunId', r.id, 'sourceId', r.source_id, 'knownEventId', r.root_event_id),
  r.source_id, r.id, now(), now(), 4
FROM ingestion.crawl_run r
WHERE r.status IN ('COMPLETED', 'PARTIAL')
  AND EXISTS (SELECT 1 FROM ingestion.raw_document d WHERE d.crawl_run_id = r.id)
ON CONFLICT (dedupe_key) DO NOTHING;
