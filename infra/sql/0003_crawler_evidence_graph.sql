ALTER TABLE ingestion.source_sync_state
  ADD COLUMN last_changed_at timestamptz;

ALTER TABLE ingestion.source ALTER COLUMN max_depth SET DEFAULT 3;
CREATE UNIQUE INDEX source_canonical_url_unique ON ingestion.source(lower(base_url)) WHERE base_url IS NOT NULL;

ALTER TABLE ingestion.crawl_run
  ADD COLUMN root_event_id uuid REFERENCES event.event(id),
  ADD COLUMN root_url text,
  ADD COLUMN job_id uuid,
  ADD COLUMN documents_created integer NOT NULL DEFAULT 0,
  ADD COLUMN error_summary jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN config_snapshot jsonb NOT NULL DEFAULT '{}';

ALTER TABLE ingestion.raw_document
  ADD COLUMN root_event_id uuid REFERENCES event.event(id),
  ADD COLUMN page_type text,
  ADD COLUMN language text,
  ADD COLUMN charset text,
  ADD COLUMN http_status integer,
  ADD COLUMN byte_size bigint,
  ADD COLUMN etag text,
  ADD COLUMN last_modified text,
  ADD COLUMN r2_bucket text NOT NULL DEFAULT 'kita-raw';

CREATE INDEX raw_document_event_time ON ingestion.raw_document(root_event_id, fetched_at DESC);
CREATE INDEX raw_document_source_time ON ingestion.raw_document(source_id, fetched_at DESC);
CREATE INDEX raw_document_page_type ON ingestion.raw_document(page_type, fetched_at DESC);
CREATE INDEX raw_document_url_version ON ingestion.raw_document(source_id, canonical_url, fetched_at DESC);

CREATE TABLE ingestion.discovered_url (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_run_id uuid NOT NULL REFERENCES ingestion.crawl_run(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES ingestion.source(id),
  root_event_id uuid REFERENCES event.event(id),
  parent_raw_document_id uuid REFERENCES ingestion.raw_document(id),
  discovered_url text NOT NULL,
  normalized_url text NOT NULL,
  anchor_text text,
  link_kind text NOT NULL,
  page_hint text,
  priority_score numeric,
  decision text NOT NULL,
  decision_reason text,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  fetched_raw_document_id uuid REFERENCES ingestion.raw_document(id),
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE(crawl_run_id, normalized_url)
);
CREATE INDEX discovered_url_event_graph ON ingestion.discovered_url(root_event_id, discovered_at);
CREATE INDEX discovered_url_parent_graph ON ingestion.discovered_url(parent_raw_document_id);
CREATE INDEX discovered_url_source_graph ON ingestion.discovered_url(source_id, discovered_at);
CREATE INDEX discovered_url_decision ON ingestion.discovered_url(crawl_run_id, decision, priority_score DESC);

CREATE TABLE ingestion.document_chunk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_document_id uuid NOT NULL REFERENCES ingestion.raw_document(id) ON DELETE CASCADE,
  root_event_id uuid REFERENCES event.event(id),
  source_id uuid NOT NULL REFERENCES ingestion.source(id),
  chunk_index integer NOT NULL,
  heading_path text,
  content text NOT NULL,
  language text,
  char_start integer,
  char_end integer,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(heading_path, '') || ' ' || content)) STORED,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE(raw_document_id, chunk_index)
);
CREATE INDEX document_chunk_document ON ingestion.document_chunk(raw_document_id, chunk_index);
CREATE INDEX document_chunk_event ON ingestion.document_chunk(root_event_id);
CREATE INDEX document_chunk_search ON ingestion.document_chunk USING gin(search_vector);
CREATE INDEX document_chunk_content_trgm ON ingestion.document_chunk USING gin(content gin_trgm_ops);

CREATE TABLE ingestion.event_source (
  event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES ingestion.source(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  discovered_url_id uuid REFERENCES ingestion.discovered_url(id),
  confidence numeric NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id, source_id, relation_type)
);

CREATE TABLE ingestion.source_candidate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_run_id uuid NOT NULL REFERENCES ingestion.crawl_run(id) ON DELETE CASCADE,
  root_event_id uuid REFERENCES event.event(id),
  discovered_url_id uuid REFERENCES ingestion.discovered_url(id),
  candidate_type text NOT NULL,
  url text NOT NULL,
  display_name text,
  confidence numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',
  evidence jsonb NOT NULL DEFAULT '{}',
  created_source_id uuid REFERENCES ingestion.source(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(crawl_run_id, candidate_type, url)
);
CREATE INDEX source_candidate_event ON ingestion.source_candidate(root_event_id, status);

ALTER TABLE ingestion.media_candidate
  ADD COLUMN root_event_id uuid REFERENCES event.event(id),
  ADD COLUMN r2_bucket text,
  ADD COLUMN r2_key text,
  ADD COLUMN fetch_status text NOT NULL DEFAULT 'DISCOVERED';

ALTER TABLE media.asset
  ADD COLUMN r2_bucket text,
  ADD COLUMN owner_type text,
  ADD COLUMN owner_id uuid;

ALTER TABLE event.event
  ADD COLUMN enrichment_state text NOT NULL DEFAULT 'DISCOVERED',
  ADD COLUMN internal_cover_asset_id uuid REFERENCES media.asset(id);

CREATE INDEX crawl_run_event_time ON ingestion.crawl_run(root_event_id, scheduled_at DESC);
CREATE INDEX media_asset_owner_category ON media.asset(owner_type, owner_id, detected_category);
CREATE INDEX media_candidate_event_category ON ingestion.media_candidate(root_event_id, category);
CREATE UNIQUE INDEX media_assignment_owner_role_unique ON media.assignment(asset_id, event_id, entity_id, venue_id, role) NULLS NOT DISTINCT;

ALTER TABLE ingestion.crawl_run
  ADD CONSTRAINT crawl_run_job_fk FOREIGN KEY (job_id) REFERENCES ingestion.job(id) DEFERRABLE INITIALLY DEFERRED;
