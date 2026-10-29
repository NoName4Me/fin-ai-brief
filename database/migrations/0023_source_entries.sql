ALTER TABLE sources ADD COLUMN additional_urls jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sources ADD COLUMN read_details boolean NOT NULL DEFAULT false;
