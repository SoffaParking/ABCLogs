-- apiloupe schema, version 1.
--
-- Raw events live in day-partitioned tables (request_events, log_events) so
-- retention drops a whole partition instead of deleting rows. Partitions are
-- created by the server as events arrive (see src/partitions.ts), not here.
-- The rollup tables hold per-minute counts and latency histograms, which is
-- what every chart reads.

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- The browser holds the token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash   bytea PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE invites (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash  bytea NOT NULL UNIQUE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  created_by  bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz
);

CREATE TABLE projects (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A key is `alk_<prefix>_<secret>`. The prefix finds the row; only the SHA-256
-- of the whole key is stored.
CREATE TABLE ingest_keys (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL UNIQUE,
  secret_hash  bytea NOT NULL,
  created_by   bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX ingest_keys_project_id_idx ON ingest_keys (project_id);

-- Every distinct route a project has reported, capped per project so a sender
-- that puts ids in its routes cannot blow up the rollups.
CREATE TABLE project_routes (
  project_id    bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  route         text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, route)
);

-- The primary keys lead with (project_id, time) so they double as the index
-- for "newest first" listings, and include time because a partitioned table's
-- unique keys must contain the partition column. The same id at the same time
-- is the same event: that is what makes re-sending a batch harmless.
CREATE TABLE request_events (
  project_id  bigint NOT NULL,
  time        timestamptz NOT NULL,
  id          text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  service     text NOT NULL,
  level       smallint NOT NULL,
  method      text NOT NULL,
  route       text NOT NULL,
  path        text NOT NULL,
  status      smallint NOT NULL,
  duration_ms real,
  request_id  text,
  attrs       jsonb,
  PRIMARY KEY (project_id, time, id)
) PARTITION BY RANGE (time);
CREATE INDEX request_events_request_id_idx
  ON request_events (project_id, request_id, time) WHERE request_id IS NOT NULL;

CREATE TABLE log_events (
  project_id    bigint NOT NULL,
  time          timestamptz NOT NULL,
  id            text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  service       text NOT NULL,
  level         smallint NOT NULL,
  message       text NOT NULL,
  request_id    text,
  error_type    text,
  error_message text,
  error_stack   text,
  attrs         jsonb,
  PRIMARY KEY (project_id, time, id)
) PARTITION BY RANGE (time);
CREATE INDEX log_events_request_id_idx
  ON log_events (project_id, request_id, time) WHERE request_id IS NOT NULL;
CREATE INDEX log_events_level_idx ON log_events (project_id, level, time);

-- hist is the latency histogram, one count per bucket of
-- HISTOGRAM_BOUNDS_MS in packages/shared/src/histogram.ts.
CREATE TABLE rollup_requests_1m (
  project_id   bigint NOT NULL,
  bucket       timestamptz NOT NULL,
  service      text NOT NULL,
  method       text NOT NULL,
  route        text NOT NULL,
  status       smallint NOT NULL,
  count        integer NOT NULL,
  duration_sum double precision NOT NULL,
  duration_max real,
  hist         integer[] NOT NULL,
  PRIMARY KEY (project_id, bucket, service, method, route, status)
);

CREATE TABLE rollup_levels_1m (
  project_id bigint NOT NULL,
  bucket     timestamptz NOT NULL,
  service    text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('request', 'log')),
  level      smallint NOT NULL,
  count      integer NOT NULL,
  PRIMARY KEY (project_id, bucket, service, kind, level)
);

CREATE TABLE ingest_stats_hourly (
  project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  hour       timestamptz NOT NULL,
  accepted   bigint NOT NULL DEFAULT 0,
  duplicates bigint NOT NULL DEFAULT 0,
  rejected   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, hour)
);
