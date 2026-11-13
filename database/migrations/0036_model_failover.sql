ALTER TABLE model_calls ADD COLUMN model_config_id text;

CREATE TABLE model_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id uuid REFERENCES model_calls(id) ON DELETE CASCADE,
  model_config_id text NOT NULL,
  model_name text NOT NULL,
  provider_model text NOT NULL,
  kind text NOT NULL DEFAULT 'call' CHECK (kind IN ('call','probe','connection-test')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  api_attempts integer NOT NULL DEFAULT 1 CHECK (api_attempts > 0),
  state text NOT NULL DEFAULT 'started' CHECK (state IN ('started','succeeded','failed')),
  error_category text,
  http_status integer,
  error text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX model_attempts_model_time ON model_attempts(model_config_id,started_at DESC);
CREATE INDEX model_attempts_time ON model_attempts(started_at DESC);

CREATE TABLE model_health (
  model_config_id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified','healthy','degraded','unavailable')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  last_probe_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_config_id text,
  event_type text NOT NULL CHECK (event_type IN (
    'fallback','recovered','unavailable','healthy','paused','primary-changed','config-changed'
  )),
  from_model_config_id text,
  to_model_config_id text,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_events_time ON model_events(created_at DESC);

CREATE TABLE model_routing (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id=1),
  current_model_config_id text,
  current_model_healthy boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO model_routing(id) VALUES(1) ON CONFLICT DO NOTHING;

UPDATE settings
SET value=jsonb_set(
  value,
  '{modelConnections}',
  CASE
    WHEN coalesce(value->'modelConnection'->>'baseUrl','') <> ''
      AND coalesce(value->'modelConnection'->>'apiKey','') <> ''
      AND coalesce(value->'modelConnection'->>'model','') <> ''
    THEN jsonb_build_array(jsonb_build_object(
      'id','legacy-primary',
      'name',coalesce(nullif(value->'modelConnection'->>'model',''),'主力模型'),
      'enabled',coalesce((value->'modelConnection'->>'enabled')::boolean,false),
      'baseUrl',value->'modelConnection'->>'baseUrl',
      'apiKey',value->'modelConnection'->>'apiKey',
      'model',value->'modelConnection'->>'model'
    ))
    ELSE '[]'::jsonb
  END
)
WHERE id=1 AND NOT value ? 'modelConnections';

UPDATE settings
SET value=value || jsonb_build_object('modelLogRetentionDays',7)
WHERE id=1 AND NOT value ? 'modelLogRetentionDays';
