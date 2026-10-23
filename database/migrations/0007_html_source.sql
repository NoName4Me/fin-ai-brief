ALTER TABLE sources DROP CONSTRAINT sources_format_check;
ALTER TABLE sources ADD CONSTRAINT sources_format_check CHECK (format IN ('rss','json','html'));
