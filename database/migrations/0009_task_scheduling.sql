ALTER TABLE articles DROP CONSTRAINT articles_state_check;
ALTER TABLE articles ADD CONSTRAINT articles_state_check CHECK (state IN ('pending','processed','ignored','failed'));
CREATE TABLE brief_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('daily','weekly','monthly')),
  period_date date NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  force boolean NOT NULL DEFAULT false,
  expected_key text,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','queued','completed','failed')),
  job_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX brief_requests_active ON brief_requests(kind,period_date) WHERE state IN ('waiting','queued');
CREATE INDEX articles_pending_period ON articles(published_at) WHERE state='pending';
