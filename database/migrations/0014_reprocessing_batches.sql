CREATE TABLE reprocessing_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  scope text NOT NULL CHECK(scope IN ('outdated','all')),
  state text NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','processing','generating','completed','completed_with_errors','failed')),
  total integer NOT NULL,
  regenerate_date date,
  generation_job_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK(range_end > range_start)
);
CREATE TABLE reprocessing_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES reprocessing_batches(id) ON DELETE CASCADE,
  article_id uuid REFERENCES articles(id) ON DELETE SET NULL,
  article_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','queued','processed','ignored','failed')),
  job_id uuid,
  error text,
  finished_at timestamptz,
  UNIQUE(batch_id,article_id)
);
CREATE INDEX reprocessing_items_pending ON reprocessing_items(batch_id,state);
