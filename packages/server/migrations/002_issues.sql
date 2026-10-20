-- Grouped errors. Every error and fatal log line belongs to an issue, keyed
-- by a fingerprint of its grouping (packages/shared/src/grouping.ts). Issues
-- outlive the raw events: their counts and status stay after the events
-- themselves pass the retention period.

CREATE TABLE issues (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id        bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  fingerprint       text NOT NULL,
  grouping_version  smallint NOT NULL,
  -- The readable grouping key, so the dashboard can say why events were grouped.
  grouping_key      text NOT NULL,
  service           text NOT NULL,
  error_type        text,
  title             text NOT NULL,
  culprit           text,
  level             smallint NOT NULL,
  status            text NOT NULL DEFAULT 'unresolved'
                    CHECK (status IN ('unresolved', 'resolved', 'ignored')),
  count             bigint NOT NULL DEFAULT 0,
  first_seen        timestamptz NOT NULL,
  last_seen         timestamptz NOT NULL,
  -- The newest occurrence, for the detail page.
  last_event_time   timestamptz,
  last_event_id     text,
  resolved_at       timestamptz,
  -- When a resolved issue last came back.
  regressed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX issues_list_idx ON issues (project_id, status, last_seen DESC);

-- Occurrences per issue and hour: the list's sparklines.
CREATE TABLE issue_counts_hourly (
  issue_id bigint NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  hour     timestamptz NOT NULL,
  count    integer NOT NULL,
  PRIMARY KEY (issue_id, hour)
);

ALTER TABLE log_events ADD COLUMN issue_id bigint;
CREATE INDEX log_events_issue_idx ON log_events (project_id, issue_id, time) WHERE issue_id IS NOT NULL;
