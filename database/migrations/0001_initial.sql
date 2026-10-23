CREATE TABLE industries (id text PRIMARY KEY, name text NOT NULL, description text NOT NULL, sections jsonb NOT NULL, position integer NOT NULL DEFAULT 0);
CREATE TABLE sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, url text NOT NULL, format text NOT NULL CHECK (format IN ('rss','json')), industry_id text NOT NULL REFERENCES industries(id), enabled boolean NOT NULL DEFAULT false, last_fetched_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), industry_id text NOT NULL REFERENCES industries(id), title text NOT NULL, summary text NOT NULL, section text NOT NULL, score integer NOT NULL CHECK (score BETWEEN 0 AND 100), occurred_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX events_period ON events(occurred_at DESC);
CREATE TABLE articles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid REFERENCES sources(id) ON DELETE SET NULL, source_name text NOT NULL, industry_id text NOT NULL REFERENCES industries(id), url text NOT NULL UNIQUE, title text NOT NULL, excerpt text NOT NULL, published_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processed','ignored')), event_id uuid REFERENCES events(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX articles_event ON articles(event_id);
CREATE TABLE briefs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK (kind IN ('daily','weekly','monthly')), period_date date NOT NULL, draft jsonb, published jsonb, generated_at timestamptz, published_at timestamptz, UNIQUE(kind,period_date));
CREATE TABLE subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, kinds jsonb NOT NULL, token_hash text NOT NULL UNIQUE, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brief_id uuid NOT NULL REFERENCES briefs(id), subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','uncertain')), error text, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(brief_id,subscription_id));
CREATE TABLE settings (id integer PRIMARY KEY CHECK (id=1), value jsonb NOT NULL);
CREATE TABLE sessions (hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE login_attempts (key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE TABLE model_calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purpose text NOT NULL, state text NOT NULL CHECK (state IN ('started','succeeded','failed')), input_tokens integer, output_tokens integer, error text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX model_calls_day ON model_calls(created_at);
INSERT INTO industries (id,name,description,sections,position) VALUES
('finance','金融','监管治理、金融机构、资管业务与行业报告','["行业监管","行业进展","相关报告"]',0),
('ai','AI','头部厂商、模型平台、技术研究与实际应用','["模型与平台","产业进展","技术研究","应用实践"]',1);
