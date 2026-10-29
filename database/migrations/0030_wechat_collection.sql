CREATE TABLE wechat_credentials (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  secret text NOT NULL,
  nickname text NOT NULL DEFAULT '',
  account_fakeid text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wechat_login_sessions (
  id uuid PRIMARY KEY,
  secret text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wechat_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fakeid text NOT NULL UNIQUE,
  nickname text NOT NULL,
  alias text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  source_id uuid NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wechat_login_sessions_expires_idx ON wechat_login_sessions(expires_at);
