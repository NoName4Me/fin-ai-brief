UPDATE settings SET value=value-'inputPrice'-'outputPrice'-'currency'-'modelDailyMoneyLimit';
UPDATE model_calls SET state='failed',request_key=NULL,error='旧请求未完成，将按任务规则自动重试',finished_at=coalesce(finished_at,now()) WHERE state='unknown';
ALTER TABLE model_calls DROP COLUMN estimated_cost, DROP COLUMN currency;
ALTER TABLE model_calls DROP CONSTRAINT model_calls_state_check;
ALTER TABLE model_calls ADD CONSTRAINT model_calls_state_check CHECK(state IN ('started','succeeded','failed'));
