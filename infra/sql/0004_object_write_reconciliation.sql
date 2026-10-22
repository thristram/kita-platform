CREATE TABLE ingestion.object_write_intent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES ingestion.job(id) ON DELETE SET NULL,
  crawl_run_id uuid REFERENCES ingestion.crawl_run(id) ON DELETE CASCADE,
  source_id uuid REFERENCES ingestion.source(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  object_key text NOT NULL,
  content_sha256 text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMMITTED','DELETED','MISSING')),
  raw_document_id uuid REFERENCES ingestion.raw_document(id) ON DELETE SET NULL,
  media_asset_id uuid REFERENCES media.asset(id) ON DELETE SET NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bucket, object_key)
);

CREATE INDEX object_write_intent_reconcile
  ON ingestion.object_write_intent(status, updated_at)
  WHERE status = 'PENDING';
