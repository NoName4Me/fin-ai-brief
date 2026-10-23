ALTER TABLE articles ADD COLUMN published_precision text NOT NULL DEFAULT 'time' CHECK (published_precision IN ('time','day'));
