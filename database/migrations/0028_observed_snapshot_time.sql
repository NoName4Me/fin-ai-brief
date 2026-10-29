ALTER TABLE articles DROP CONSTRAINT articles_published_precision_check;
ALTER TABLE articles ADD CONSTRAINT articles_published_precision_check CHECK (published_precision IN ('time','day','observed'));
