CREATE TABLE subscription_confirmations (
  email text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  kinds jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
