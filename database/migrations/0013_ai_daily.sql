-- Legacy industry IDs remain only for historical snapshots and foreign-key compatibility.
ALTER TABLE articles ADD COLUMN assessment jsonb;
ALTER TABLE events ADD COLUMN assessment jsonb;
ALTER TABLE events ADD COLUMN tags jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE edition_runs (
  period_date date NOT NULL,
  section text NOT NULL,
  status text NOT NULL CHECK(status IN ('unscheduled','skipped','error','published','ready')),
  candidate_count integer NOT NULL DEFAULT 0,
  selected_count integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(period_date,section)
);
UPDATE sources SET industry_id='ai';
UPDATE settings SET value=value || '{"weeklyEnabled":false,"monthlyEnabled":false,"dailyTime":"08:00","dailyEnabled":true,"minScore":70,"maxItems":19,"autoPublish":true,"editorialPrompt":"只关注AI发展与治理，以及明确改变AI研发、部署、采购或使用条件的内容。金融、AMC是重点关注领域，涵盖监管、风险、资本、采购与应用；普通金融新闻、泛数字化和无法说明AI关联的内容不收录。"}'::jsonb;
