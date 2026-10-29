ALTER TABLE subscriptions ADD COLUMN subscribed_at timestamptz;
UPDATE subscriptions SET subscribed_at=created_at;
ALTER TABLE subscriptions ALTER COLUMN subscribed_at SET NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN subscribed_at SET DEFAULT now();
ALTER TABLE subscriptions ADD COLUMN unsubscribed_at timestamptz;
UPDATE subscriptions SET unsubscribed_at=now() WHERE active=false;
