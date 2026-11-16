CREATE TABLE app.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_visitor_id text NOT NULL,
  title text NOT NULL,
  horizon_start text NOT NULL,
  horizon_days integer NOT NULL DEFAULT 7,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  status text NOT NULL DEFAULT 'draft',
  source_template_id uuid,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_owner_idx ON app.plans (owner_visitor_id, created_at);

CREATE TABLE app.task_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES app.plans(id),
  key text NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  duration_min integer NOT NULL,
  frequency jsonb NOT NULL,
  priority text NOT NULL DEFAULT 'mid',
  splittable boolean NOT NULL DEFAULT false,
  preferred_period text,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (plan_id, key)
);

CREATE TABLE app.constraints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES app.plans(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'user',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX constraints_plan_idx ON app.constraints (plan_id);

CREATE TABLE app.blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES app.plans(id),
  task_def_id uuid REFERENCES app.task_defs(id),
  title text NOT NULL,
  category text NOT NULL,
  start_utc timestamptz NOT NULL,
  end_utc timestamptz NOT NULL,
  priority text NOT NULL DEFAULT 'mid',
  pinned boolean NOT NULL DEFAULT false,
  origin text NOT NULL DEFAULT 'engine',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blocks_plan_start_idx ON app.blocks (plan_id, start_utc);

CREATE TABLE app.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_visitor_id text NOT NULL,
  title text NOT NULL DEFAULT '新对话',
  plan_id uuid REFERENCES app.plans(id),
  qca_session_id text,
  status text NOT NULL DEFAULT 'active',
  last_seq bigint NOT NULL DEFAULT 0,
  last_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner_idx ON app.conversations (owner_visitor_id, updated_at);

CREATE TABLE app.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES app.conversations(id),
  seq bigint NOT NULL,
  role text NOT NULL,
  kind text NOT NULL,
  content text NOT NULL DEFAULT '',
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE app.dispatch_intents (
  request_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES app.conversations(id),
  visitor_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payload_fingerprint text,
  session_id text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX dispatch_visitor_idx ON app.dispatch_intents (visitor_id, status);

CREATE TABLE app.commit_log (
  preview_id uuid PRIMARY KEY,
  visitor_id text NOT NULL,
  plan_id uuid NOT NULL REFERENCES app.plans(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.quotas (
  visitor_id text NOT NULL,
  day text NOT NULL,
  chat_turns integer NOT NULL DEFAULT 0,
  publishes integer NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_id, day)
);

CREATE TABLE app.cloud_bindings (
  key text PRIMARY KEY,
  state text,
  resource_id text,
  version integer NOT NULL DEFAULT 0,
  fingerprint text,
  lease_token text,
  updated_at timestamptz NOT NULL DEFAULT now()
);