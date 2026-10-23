UPDATE processing_steps SET error='先前请求未完成，任务将自动重试' WHERE error LIKE '%模型页%' OR error LIKE '%放行%';
UPDATE model_calls SET error='先前请求未完成，可自动重试',request_key=NULL WHERE state='failed' AND (error LIKE '%模型页%' OR error LIKE '%放行%');
