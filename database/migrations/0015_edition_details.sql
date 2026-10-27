ALTER TABLE edition_runs ADD COLUMN details jsonb NOT NULL DEFAULT '[]'::jsonb;
