-- Structured content required by the Event overview, schedule, exhibitors,
-- related fandoms and updates views. Every crawler/LLM-derived row retains
-- the raw documents that support it; consumer engagement remains separate.

CREATE TABLE IF NOT EXISTS event.event_fact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE,
  fact_type text NOT NULL, label text NOT NULL, value_json jsonb NOT NULL, unit text,
  confidence numeric NOT NULL, source_document_ids uuid[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,fact_type,label)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_link_identity ON event.event_link(event_id,link_type,url);

CREATE TABLE IF NOT EXISTS event.ticket_offer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE,
  external_key text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', purchase_url text,
  price_text text NOT NULL DEFAULT '', availability text NOT NULL DEFAULT 'UNKNOWN', valid_from timestamptz, valid_through timestamptz,
  confidence numeric NOT NULL, source_document_ids uuid[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,external_key)
);

CREATE TABLE IF NOT EXISTS event.exhibitor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE,
  external_key text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', booth text NOT NULL DEFAULT '',
  categories text[] NOT NULL DEFAULT '{}', featured boolean NOT NULL DEFAULT false, website_url text,
  organization_names text[] NOT NULL DEFAULT '{}', logo_media_candidate_id uuid REFERENCES ingestion.media_candidate(id),
  confidence numeric NOT NULL, source_document_ids uuid[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,external_key)
);
CREATE INDEX IF NOT EXISTS event_exhibitor_name_trgm ON event.exhibitor USING gin(name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS event.session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE,
  external_key text NOT NULL, title text NOT NULL, session_type text NOT NULL, description text NOT NULL DEFAULT '',
  start_at timestamptz, end_at timestamptz, timezone text NOT NULL DEFAULT 'UTC', venue_name text NOT NULL DEFAULT '', room text NOT NULL DEFAULT '',
  age_rating text NOT NULL DEFAULT '', organization_names text[] NOT NULL DEFAULT '{}', subject_targets jsonb NOT NULL DEFAULT '[]',
  person_targets jsonb NOT NULL DEFAULT '[]', image_media_candidate_id uuid REFERENCES ingestion.media_candidate(id), tags text[] NOT NULL DEFAULT '{}',
  confidence numeric NOT NULL, source_document_ids uuid[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,external_key)
);
CREATE INDEX IF NOT EXISTS event_session_start ON event.session(event_id,start_at);

CREATE TABLE IF NOT EXISTS event.guest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE,
  external_key text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', role text NOT NULL DEFAULT '',
  organization_names text[] NOT NULL DEFAULT '{}', person_target jsonb, subject_targets jsonb NOT NULL DEFAULT '[]',
  image_media_candidate_id uuid REFERENCES ingestion.media_candidate(id), confidence numeric NOT NULL,
  source_document_ids uuid[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,external_key)
);

CREATE TABLE IF NOT EXISTS event.event_update (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE,
  external_key text NOT NULL, title text NOT NULL, summary text NOT NULL DEFAULT '', published_at timestamptz,
  category text NOT NULL, source_name text NOT NULL DEFAULT '', source_url text, image_media_candidate_id uuid REFERENCES ingestion.media_candidate(id),
  confidence numeric NOT NULL, source_document_ids uuid[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,external_key)
);
CREATE INDEX IF NOT EXISTS event_update_published ON event.event_update(event_id,published_at DESC);

CREATE TABLE IF NOT EXISTS event.activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE,
  external_key text NOT NULL, activity_type text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
  start_at timestamptz, end_at timestamptz, location text NOT NULL DEFAULT '', exhibitor_external_key text, session_external_key text,
  organization_names text[] NOT NULL DEFAULT '{}', subject_targets jsonb NOT NULL DEFAULT '[]', person_targets jsonb NOT NULL DEFAULT '[]',
  media_candidate_ids uuid[] NOT NULL DEFAULT '{}', confidence numeric NOT NULL, source_document_ids uuid[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,external_key)
);
CREATE INDEX IF NOT EXISTS event_activity_type ON event.activity(event_id,activity_type);

CREATE TABLE IF NOT EXISTS event.related_subject (
  event_id uuid NOT NULL REFERENCES event.event(id) ON DELETE CASCADE, canonical_key text NOT NULL,
  provider text NOT NULL, entity_type text NOT NULL, raw_id bigint NOT NULL, encoded_id bigint NOT NULL,
  label text NOT NULL, description text NOT NULL DEFAULT '', featured boolean NOT NULL DEFAULT false,
  confidence numeric NOT NULL, source_document_ids uuid[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,canonical_key)
);
