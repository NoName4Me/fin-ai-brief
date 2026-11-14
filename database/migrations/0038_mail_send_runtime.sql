CREATE TABLE mail_send_runtime (
  connection_key text PRIMARY KEY,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz
);
