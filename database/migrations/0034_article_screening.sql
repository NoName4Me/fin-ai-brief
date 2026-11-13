CREATE TABLE article_screenings (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_key text NOT NULL,
  batch_key text NOT NULL,
  batch_size integer NOT NULL CHECK (batch_size BETWEEN 1 AND 20),
  member_index integer NOT NULL CHECK (member_index >= 0 AND member_index < batch_size),
  decision text NOT NULL CHECK (decision IN ('PASS','BLOCK','UNCERTAIN')),
  reason text NOT NULL,
  fallback boolean NOT NULL DEFAULT false,
  call_id uuid REFERENCES model_calls(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(article_id,input_key)
);
CREATE INDEX article_screenings_batch ON article_screenings(batch_key);
