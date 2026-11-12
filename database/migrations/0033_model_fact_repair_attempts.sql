ALTER TABLE model_calls
  DROP CONSTRAINT model_calls_api_attempts_check,
  ADD CONSTRAINT model_calls_api_attempts_check CHECK (api_attempts BETWEEN 0 AND 3);
