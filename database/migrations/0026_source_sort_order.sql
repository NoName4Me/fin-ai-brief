ALTER TABLE sources ADD COLUMN sort_order integer NOT NULL DEFAULT 1000000;
UPDATE sources SET sort_order=substring(catalog_key from '[0-9]+$')::integer
WHERE catalog_key ~ '^leader-xlsx:[0-9]+$';
UPDATE sources SET sort_order=2147483647 WHERE name='AIHOT';
