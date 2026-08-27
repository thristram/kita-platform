ALTER TABLE core.entity ADD COLUMN data_origin text NOT NULL DEFAULT 'LIVE' CHECK (data_origin IN ('LIVE', 'MOCK'));
ALTER TABLE event.venue ADD COLUMN data_origin text NOT NULL DEFAULT 'LIVE' CHECK (data_origin IN ('LIVE', 'MOCK'));
ALTER TABLE event.event ADD COLUMN data_origin text NOT NULL DEFAULT 'LIVE' CHECK (data_origin IN ('LIVE', 'MOCK'));
ALTER TABLE media.asset ADD COLUMN data_origin text NOT NULL DEFAULT 'LIVE' CHECK (data_origin IN ('LIVE', 'MOCK'));
ALTER TABLE ingestion.source ADD COLUMN data_origin text NOT NULL DEFAULT 'LIVE' CHECK (data_origin IN ('LIVE', 'MOCK'));
ALTER TABLE serving.event_listing ADD COLUMN data_origin text NOT NULL DEFAULT 'LIVE' CHECK (data_origin IN ('LIVE', 'MOCK'));
ALTER TABLE serving.event_document ADD COLUMN data_origin text NOT NULL DEFAULT 'LIVE' CHECK (data_origin IN ('LIVE', 'MOCK'));
ALTER TABLE serving.entity_document ADD COLUMN data_origin text NOT NULL DEFAULT 'LIVE' CHECK (data_origin IN ('LIVE', 'MOCK'));

ALTER TABLE ingestion.source
  ADD COLUMN officiality text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN schedule_cron text,
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN robots_mode text NOT NULL DEFAULT 'ENFORCE',
  ADD COLUMN terms_review_status text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN terms_reviewed_at timestamptz,
  ADD COLUMN terms_review_note text,
  ADD COLUMN contact_identity text,
  ADD COLUMN allowed_domains text[] NOT NULL DEFAULT '{}',
  ADD COLUMN allowed_path_prefixes text[] NOT NULL DEFAULT ARRAY['/'],
  ADD COLUMN denied_path_prefixes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN max_depth integer NOT NULL DEFAULT 2,
  ADD COLUMN max_pages_per_run integer NOT NULL DEFAULT 100,
  ADD COLUMN max_bytes_per_run bigint NOT NULL DEFAULT 262144000,
  ADD COLUMN max_runtime_seconds integer NOT NULL DEFAULT 1800,
  ADD COLUMN http_requests_per_minute integer NOT NULL DEFAULT 30,
  ADD COLUMN http_concurrency_per_domain integer NOT NULL DEFAULT 2,
  ADD COLUMN browser_requests_per_minute integer NOT NULL DEFAULT 6,
  ADD COLUMN browser_concurrency_per_domain integer NOT NULL DEFAULT 1,
  ADD COLUMN default_fetch_mode text NOT NULL DEFAULT 'HTTP',
  ADD COLUMN allow_stealth boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_authenticated_session boolean NOT NULL DEFAULT false,
  ADD COLUMN store_html boolean NOT NULL DEFAULT true,
  ADD COLUMN store_screenshot_policy text NOT NULL DEFAULT 'ON_FAILURE',
  ADD COLUMN media_policy jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN retention_policy jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN pause_reason text;

CREATE TABLE ingestion.crawl_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES ingestion.source(id),
  trigger text NOT NULL,
  connector_key text NOT NULL,
  connector_version text NOT NULL,
  worker_version text NOT NULL,
  policy_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  pages_scheduled integer NOT NULL DEFAULT 0,
  pages_fetched integer NOT NULL DEFAULT 0,
  pages_unchanged integer NOT NULL DEFAULT 0,
  pages_blocked integer NOT NULL DEFAULT 0,
  pages_failed integer NOT NULL DEFAULT 0,
  bytes_fetched bigint NOT NULL DEFAULT 0,
  assertions_emitted integer NOT NULL DEFAULT 0,
  candidates_emitted integer NOT NULL DEFAULT 0,
  media_discovered integer NOT NULL DEFAULT 0,
  logos_discovered integer NOT NULL DEFAULT 0,
  warnings_count integer NOT NULL DEFAULT 0,
  logo_discovery_status text,
  budget_stop_reason text,
  checkpoint_before jsonb NOT NULL DEFAULT '{}',
  checkpoint_after jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crawl_run_source_started ON ingestion.crawl_run(source_id, scheduled_at DESC);

CREATE TABLE ingestion.fetch_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_run_id uuid NOT NULL REFERENCES ingestion.crawl_run(id),
  source_id uuid NOT NULL REFERENCES ingestion.source(id),
  requested_url text NOT NULL,
  final_url text,
  status_code integer,
  fetch_mode_used text NOT NULL,
  request_headers_redacted jsonb NOT NULL DEFAULT '{}',
  response_headers_redacted jsonb NOT NULL DEFAULT '{}',
  content_type text,
  encoding text,
  content_length bigint,
  body_r2_key text,
  screenshot_r2_key text,
  xhr_manifest_r2_key text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  etag text,
  last_modified text,
  content_sha256 text,
  simhash text,
  escalation_reason text,
  blocked_reason text,
  error_class text,
  error_message_redacted text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fetch_attempt_run_time ON ingestion.fetch_attempt(crawl_run_id, fetched_at);

ALTER TABLE ingestion.raw_document
  ADD COLUMN crawl_run_id uuid REFERENCES ingestion.crawl_run(id),
  ADD COLUMN fetch_attempt_id uuid REFERENCES ingestion.fetch_attempt(id),
  ADD COLUMN connector_key text,
  ADD COLUMN connector_version text,
  ADD COLUMN extraction_version text;

ALTER TABLE ingestion.assertion
  ALTER COLUMN subject_id DROP NOT NULL,
  ADD COLUMN crawl_run_id uuid REFERENCES ingestion.crawl_run(id),
  ADD COLUMN subject_external_key text,
  ADD COLUMN normalized_value_json jsonb,
  ADD COLUMN evidence_locator text,
  ADD COLUMN evidence_excerpt text;

CREATE TABLE ingestion.media_candidate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_document_id uuid NOT NULL REFERENCES ingestion.raw_document(id),
  source_id uuid NOT NULL REFERENCES ingestion.source(id),
  crawl_run_id uuid NOT NULL REFERENCES ingestion.crawl_run(id),
  source_url text NOT NULL,
  resolved_url text NOT NULL,
  owner_hint_type text NOT NULL DEFAULT 'UNKNOWN',
  owner_hint_external_key text,
  category text NOT NULL DEFAULT 'OTHER',
  storage_mode text NOT NULL DEFAULT 'REMOTE',
  usage_scope text NOT NULL DEFAULT 'INTERNAL',
  license_status text NOT NULL DEFAULT 'UNKNOWN',
  mime_type text,
  width integer,
  height integer,
  byte_size bigint,
  aspect_ratio numeric,
  has_alpha boolean,
  sha256 text,
  perceptual_hash text,
  source_signals jsonb NOT NULL DEFAULT '{}',
  classification_score numeric NOT NULL DEFAULT 0,
  classification_reasons text[] NOT NULL DEFAULT '{}',
  attribution text,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  UNIQUE(raw_document_id, resolved_url, category)
);
CREATE INDEX media_candidate_owner ON ingestion.media_candidate(owner_hint_type, owner_hint_external_key);

ALTER TABLE ingestion.job
  ADD COLUMN source_id uuid REFERENCES ingestion.source(id),
  ADD COLUMN crawl_run_id uuid REFERENCES ingestion.crawl_run(id),
  ADD COLUMN not_before timestamptz,
  ADD COLUMN lease_owner text,
  ADD COLUMN last_error_class text,
  ADD COLUMN last_error_code text,
  ADD COLUMN last_error_message_redacted text,
  ADD COLUMN finished_at timestamptz;
UPDATE ingestion.job SET not_before = available_at WHERE not_before IS NULL;
CREATE INDEX crawler_job_lease_queue ON ingestion.job(status, not_before, priority) WHERE job_type IN ('SOURCE_DISCOVERY','URL_FETCH','DOCUMENT_EXTRACT','MEDIA_FETCH','MEDIA_ANALYZE','SOURCE_REPLAY','SOURCE_HEALTH_CHECK');
CREATE UNIQUE INDEX crawler_worker_name_unique ON ingestion.worker(worker_name);

CREATE TABLE system.runtime_setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system.runtime_setting(key, value, description)
VALUES ('consumer_show_mock_data', 'true'::jsonb, 'Include records tagged MOCK in consumer-facing queries')
ON CONFLICT (key) DO NOTHING;

INSERT INTO core.entity(id, entity_type, canonical_name, summary, metadata, data_origin)
VALUES
  ('c0000000-0000-4000-8000-000000000001', 'ORGANIZATION', 'Society for the Promotion of Japanese Animation', 'Organizer of Anime Expo.', '{"tone":"red","short":"SPJA"}', 'MOCK'),
  ('c0000000-0000-4000-8000-000000000002', 'FANDOM', 'Frieren', 'Fantasy manga and anime franchise.', '{"tone":"blue","short":"FR"}', 'MOCK'),
  ('c0000000-0000-4000-8000-000000000003', 'ARTIST', 'YOASOBI', 'Japanese music duo.', '{"tone":"violet","short":"YO"}', 'MOCK'),
  ('c0000000-0000-4000-8000-000000000004', 'ORGANIZATION', 'Good Smile Company', 'Japanese figure and hobby manufacturer.', '{"tone":"amber","short":"GSC"}', 'MOCK')
ON CONFLICT (id) DO UPDATE SET canonical_name = EXCLUDED.canonical_name, metadata = EXCLUDED.metadata, data_origin = 'MOCK';

INSERT INTO event.venue(id, name, address_line1, city, region, country_code, timezone, metadata, data_origin)
VALUES
  ('b0000000-0000-4000-8000-000000000001', 'Los Angeles Convention Center', '1201 S Figueroa St', 'Los Angeles', 'CA', 'US', 'America/Los_Angeles', '{"tone":"slate"}', 'MOCK'),
  ('b0000000-0000-4000-8000-000000000002', 'Climate Pledge Arena', '334 1st Ave N', 'Seattle', 'WA', 'US', 'America/Los_Angeles', '{"tone":"violet"}', 'MOCK'),
  ('b0000000-0000-4000-8000-000000000003', 'Tokyo International Forum', '3 Chome-5-1 Marunouchi', 'Tokyo', 'Tokyo', 'JP', 'Asia/Tokyo', '{"tone":"blue"}', 'MOCK'),
  ('b0000000-0000-4000-8000-000000000004', 'Moscone Center', '747 Howard St', 'San Francisco', 'CA', 'US', 'America/Los_Angeles', '{"tone":"rose"}', 'MOCK')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata, data_origin = 'MOCK';

INSERT INTO event.event(id, event_type, canonical_name, start_at, end_at, timezone, venue_id, organizer_entity_id, official_url, status, importance_score, metadata, data_origin)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'CONVENTION', 'Anime Expo 2027', '2027-07-02 16:00:00+00', '2027-07-06 01:00:00+00', 'America/Los_Angeles', 'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'https://www.anime-expo.org/', 'PUBLISHED', 98, '{"tone":"coral","short":"AX","mock":true}', 'MOCK'),
  ('a0000000-0000-4000-8000-000000000002', 'CONCERT', 'YOASOBI Live in Seattle', '2026-10-19 02:00:00+00', '2026-10-19 05:00:00+00', 'America/Los_Angeles', 'b0000000-0000-4000-8000-000000000002', NULL, 'https://www.yoasobi-music.jp/', 'PUBLISHED', 82, '{"tone":"violet","short":"YO","mock":true}', 'MOCK'),
  ('a0000000-0000-4000-8000-000000000003', 'CONCERT', 'Frieren Orchestra Concert', '2026-09-27 09:00:00+00', '2026-09-27 12:00:00+00', 'Asia/Tokyo', 'b0000000-0000-4000-8000-000000000003', NULL, NULL, 'REVIEW', 76, '{"tone":"blue","short":"FR","mock":true}', 'MOCK'),
  ('a0000000-0000-4000-8000-000000000004', 'POP_UP', 'Good Smile AX Exclusive Pop-up', '2027-07-03 16:00:00+00', '2027-07-06 01:00:00+00', 'America/Los_Angeles', 'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000004', 'https://www.goodsmile.com/', 'DRAFT', 67, '{"tone":"amber","short":"GSC","mock":true}', 'MOCK'),
  ('a0000000-0000-4000-8000-000000000005', 'EXHIBITION', 'Demon Slayer World Tour', '2026-08-10 17:00:00+00', '2026-08-25 00:00:00+00', 'America/Los_Angeles', 'b0000000-0000-4000-8000-000000000004', NULL, NULL, 'PUBLISHED', 73, '{"tone":"rose","short":"DS","mock":true}', 'MOCK')
ON CONFLICT (id) DO UPDATE SET canonical_name = EXCLUDED.canonical_name, status = EXCLUDED.status, metadata = EXCLUDED.metadata, data_origin = 'MOCK';

INSERT INTO event.event_entity(event_id, entity_id, relation_type, origin, confidence, status)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'FEATURES', 'MOCK_SEED', 0.90, 'ACTIVE'),
  ('a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003', 'FEATURES', 'MOCK_SEED', 1.00, 'ACTIVE'),
  ('a0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000002', 'FEATURES', 'MOCK_SEED', 1.00, 'ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO ingestion.source(id, name, source_type, connector_key, base_url, trust_level, priority, enabled, config, officiality, terms_review_status, terms_review_note, allowed_domains, data_origin)
VALUES
  ('d0000000-0000-4000-8000-000000000001', 'Anime Expo Official', 'WEBSITE', 'website', 'https://www.anime-expo.org/', 'OFFICIAL', 'HIGH', false, '{"seed_urls":["https://www.anime-expo.org/"]}', 'FIRST_PARTY', 'UNKNOWN', 'Mock registry record. Review policy before enabling.', ARRAY['www.anime-expo.org','anime-expo.org'], 'MOCK'),
  ('d0000000-0000-4000-8000-000000000002', 'YOASOBI Official', 'WEBSITE', 'website', 'https://www.yoasobi-music.jp/', 'OFFICIAL', 'NORMAL', false, '{"seed_urls":["https://www.yoasobi-music.jp/"]}', 'FIRST_PARTY', 'UNKNOWN', 'Mock registry record. Review policy before enabling.', ARRAY['www.yoasobi-music.jp','yoasobi-music.jp'], 'MOCK'),
  ('d0000000-0000-4000-8000-000000000003', 'Good Smile Company', 'WEBSITE', 'website', 'https://www.goodsmile.com/', 'OFFICIAL', 'NORMAL', false, '{"seed_urls":["https://www.goodsmile.com/"]}', 'FIRST_PARTY', 'UNKNOWN', 'Mock registry record. Review policy before enabling.', ARRAY['www.goodsmile.com','goodsmile.com'], 'MOCK')
ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, allowed_domains = EXCLUDED.allowed_domains, data_origin = 'MOCK';

INSERT INTO media.asset(id, origin, source_url, original_filename, mime_type, width, height, detected_category, classification_confidence, usage_scope, rights_status, metadata, data_origin)
VALUES
  ('e0000000-0000-4000-8000-000000000001', 'MOCK_SEED', NULL, 'ax-2027-key-visual.jpg', 'image/jpeg', 1920, 1080, 'EVENT_HERO', 0.98, 'INTERNAL_ONLY', 'UNKNOWN', '{"title":"AX 2027 Key Visual","tone":"coral","short":"AX"}', 'MOCK'),
  ('e0000000-0000-4000-8000-000000000002', 'MOCK_SEED', NULL, 'anime-expo-poster.jpg', 'image/jpeg', 1080, 1350, 'EVENT_POSTER', 0.96, 'INTERNAL_ONLY', 'UNKNOWN', '{"title":"Anime Expo Poster","tone":"navy","short":"AX"}', 'MOCK'),
  ('e0000000-0000-4000-8000-000000000003', 'MOCK_SEED', NULL, 'ax-logo.png', 'image/png', 1024, 1024, 'EVENT_LOGO', 1.00, 'INTERNAL_ONLY', 'UNKNOWN', '{"title":"AX Logo","tone":"red","short":"AX"}', 'MOCK'),
  ('e0000000-0000-4000-8000-000000000004', 'MOCK_SEED', NULL, 'frieren-orchestra.jpg', 'image/jpeg', 1400, 2100, 'FANDOM_POSTER', 0.92, 'INTERNAL_ONLY', 'UNKNOWN', '{"title":"Frieren Orchestra","tone":"blue","short":"FR"}', 'MOCK'),
  ('e0000000-0000-4000-8000-000000000005', 'MOCK_SEED', NULL, 'yoasobi-seattle.jpg', 'image/jpeg', 1920, 1080, 'EVENT_HERO', 0.94, 'INTERNAL_ONLY', 'UNKNOWN', '{"title":"YOASOBI Seattle","tone":"violet","short":"YO"}', 'MOCK'),
  ('e0000000-0000-4000-8000-000000000006', 'MOCK_SEED', NULL, 'good-smile-ax.jpg', 'image/jpeg', 1080, 1080, 'SOCIAL_POST', 0.88, 'EVIDENCE_ONLY', 'UNKNOWN', '{"title":"Good Smile AX","tone":"amber","short":"GSC"}', 'MOCK')
ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata, data_origin = 'MOCK';

INSERT INTO media.assignment(id, asset_id, event_id, role, is_default_internal, is_primary_public, pinned, priority_score, metadata)
VALUES
  ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'EVENT_HERO', true, false, false, 98, '{"mock":true}'),
  ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'EVENT_POSTER', true, false, false, 96, '{"mock":true}'),
  ('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'EVENT_LOGO', true, false, false, 100, '{"mock":true}')
ON CONFLICT (id) DO UPDATE SET priority_score = EXCLUDED.priority_score;

INSERT INTO serving.event_listing(event_id, slug, status, event_type, title, start_at, end_at, timezone, city, region, country, primary_image_url, primary_fandom_ids, popularity_score, canonical_version, projection_version, data_origin)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'anime-expo-2027', 'PUBLISHED', 'CONVENTION', 'Anime Expo 2027', '2027-07-02 16:00:00+00', '2027-07-06 01:00:00+00', 'America/Los_Angeles', 'Los Angeles', 'CA', 'US', NULL, ARRAY['c0000000-0000-4000-8000-000000000002'::uuid], 98, 1, 1, 'MOCK'),
  ('a0000000-0000-4000-8000-000000000002', 'yoasobi-live-seattle-2026', 'PUBLISHED', 'CONCERT', 'YOASOBI Live in Seattle', '2026-10-19 02:00:00+00', '2026-10-19 05:00:00+00', 'America/Los_Angeles', 'Seattle', 'WA', 'US', NULL, ARRAY['c0000000-0000-4000-8000-000000000003'::uuid], 82, 1, 1, 'MOCK'),
  ('a0000000-0000-4000-8000-000000000005', 'demon-slayer-world-tour-2026', 'PUBLISHED', 'EXHIBITION', 'Demon Slayer World Tour', '2026-08-10 17:00:00+00', '2026-08-25 00:00:00+00', 'America/Los_Angeles', 'San Francisco', 'CA', 'US', NULL, '{}', 73, 1, 1, 'MOCK')
ON CONFLICT (event_id) DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status, data_origin = 'MOCK';
