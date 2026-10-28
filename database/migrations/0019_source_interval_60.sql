ALTER TABLE sources ALTER COLUMN interval_minutes SET DEFAULT 60;
ALTER TABLE sources ALTER COLUMN min_interval_minutes SET DEFAULT 60;

UPDATE sources
SET interval_minutes=60,
    min_interval_minutes=60,
    max_interval_minutes=greatest(max_interval_minutes,60);
