ALTER TABLE model_calls
  ADD COLUMN api_attempts integer NOT NULL DEFAULT 0
  CHECK (api_attempts BETWEEN 0 AND 2);

UPDATE model_calls
SET api_attempts = 1
WHERE state = 'succeeded' AND input_tokens IS NOT NULL;
