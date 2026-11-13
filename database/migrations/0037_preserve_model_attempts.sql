ALTER TABLE model_attempts
  DROP CONSTRAINT model_attempts_call_id_fkey,
  ADD CONSTRAINT model_attempts_call_id_fkey
    FOREIGN KEY(call_id) REFERENCES model_calls(id) ON DELETE SET NULL;
