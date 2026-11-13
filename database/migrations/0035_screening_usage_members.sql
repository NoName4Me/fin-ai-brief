CREATE TABLE screening_usage_members (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  batch_key text NOT NULL,
  batch_size integer NOT NULL CHECK (batch_size BETWEEN 1 AND 20),
  member_index integer NOT NULL CHECK (member_index >= 0 AND member_index < batch_size),
  PRIMARY KEY(article_id,batch_key)
);
CREATE INDEX screening_usage_members_batch ON screening_usage_members(batch_key);
