CREATE TABLE source_discoveries (
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text NOT NULL,
  published_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  inserted boolean NOT NULL DEFAULT false,
  material_kind text NOT NULL DEFAULT 'unknown' CHECK(material_kind IN ('full','summary','title','unknown')),
  PRIMARY KEY(source_id,url)
);
CREATE INDEX source_discoveries_first_seen ON source_discoveries(source_id,first_seen_at);
CREATE INDEX source_discoveries_url ON source_discoveries(url);
CREATE TABLE collection_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title text NOT NULL,
  url text,
  published_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK(outcome IN ('new','known','repeated','outside_window','invalid','failed'))
);
CREATE INDEX collection_items_source_day ON collection_items(source_id,observed_at);
CREATE TABLE source_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  verdict text NOT NULL CHECK(verdict IN ('keep','scope','slower','stop','observe')),
  evidence_kind text NOT NULL CHECK(evidence_kind IN ('original','reprint','aggregator','unknown')),
  completeness text NOT NULL CHECK(completeness IN ('sufficient','thin','title','unknown')),
  note text NOT NULL,
  urls jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX source_reviews_recent ON source_reviews(source_id,created_at DESC);
-- Recover only evidence retained in existing records. No synthetic missing observations.
INSERT INTO source_discoveries(source_id,url,title,published_at,first_seen_at,last_seen_at,inserted)
SELECT source_id,url,title,published_at,created_at,created_at,true FROM articles WHERE source_id IS NOT NULL;
INSERT INTO source_discoveries(source_id,url,title,published_at,first_seen_at,last_seen_at)
SELECT r.source_id,a.url,max(a.title),min(a.published_at),min(r.started_at),max(r.started_at)
FROM collection_runs r CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(r.result->'urls')='array' THEN r.result->'urls' ELSE '[]'::jsonb END) u(url)
JOIN articles a ON a.url=u.url WHERE r.source_id IS NOT NULL AND r.state='succeeded'
GROUP BY r.source_id,a.url
ON CONFLICT(source_id,url) DO UPDATE SET first_seen_at=least(source_discoveries.first_seen_at,excluded.first_seen_at),last_seen_at=greatest(source_discoveries.last_seen_at,excluded.last_seen_at);
