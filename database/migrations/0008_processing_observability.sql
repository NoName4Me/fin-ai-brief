ALTER TABLE sources ADD COLUMN auto_interval boolean NOT NULL DEFAULT false,
  ADD COLUMN min_interval_minutes integer,
  ADD COLUMN max_interval_minutes integer,
  ADD COLUMN interval_reason text,
  ADD COLUMN quiet_runs integer NOT NULL DEFAULT 0,
  ADD COLUMN failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN stable_runs integer NOT NULL DEFAULT 0;
UPDATE sources SET min_interval_minutes=interval_minutes,max_interval_minutes=greatest(interval_minutes,240);
ALTER TABLE sources ALTER COLUMN min_interval_minutes SET DEFAULT 30, ALTER COLUMN min_interval_minutes SET NOT NULL,
  ALTER COLUMN max_interval_minutes SET DEFAULT 240, ALTER COLUMN max_interval_minutes SET NOT NULL;
ALTER TABLE model_calls ADD COLUMN subject text, ADD COLUMN model text, ADD COLUMN input_hash text,
  ADD COLUMN input_summary jsonb, ADD COLUMN response jsonb, ADD COLUMN finished_at timestamptz,
  ADD COLUMN request_key text, ADD COLUMN estimated_cost numeric(18,8), ADD COLUMN currency text,
  ADD COLUMN reused_count integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX model_calls_request_key ON model_calls(request_key) WHERE request_key IS NOT NULL;
CREATE INDEX model_calls_subject ON model_calls(subject,created_at DESC);
CREATE TABLE processing_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject text NOT NULL, run_key text NOT NULL, stage text NOT NULL,
  state text NOT NULL CHECK(state IN ('running','succeeded','failed','waiting','skipped')),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, result jsonb, error text,
  call_id uuid REFERENCES model_calls(id) ON DELETE SET NULL, UNIQUE(subject,run_key,stage)
);
CREATE INDEX processing_steps_subject ON processing_steps(subject,started_at);
CREATE TABLE collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  source_name text NOT NULL, url text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz, state text NOT NULL DEFAULT 'running', result jsonb, error text
);
ALTER TABLE articles ADD COLUMN processing_version text, ADD COLUMN input_hash text, ADD COLUMN facts jsonb,
  ADD COLUMN score_reason text, ADD COLUMN review_note text;
CREATE TABLE event_developments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE, fact_hash text NOT NULL,
  facts jsonb NOT NULL, happened_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,fact_hash)
);
CREATE INDEX developments_period ON event_developments(happened_at,event_id);
CREATE TABLE news_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX news_changes_event ON news_changes(event_id,id);
CREATE TABLE source_hosts (
  host text PRIMARY KEY, next_request_at timestamptz NOT NULL DEFAULT now(), blocked_until timestamptz
);
ALTER TABLE model_calls DROP CONSTRAINT model_calls_state_check;
ALTER TABLE model_calls ADD CONSTRAINT model_calls_state_check CHECK(state IN ('started','succeeded','failed','unknown'));
