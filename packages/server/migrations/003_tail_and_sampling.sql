-- Live tail reads log lines in the order they arrived, newest first.
CREATE INDEX log_events_received_idx ON log_events (project_id, received_at);

-- Sampling: a sender that keeps one event in N marks it with weight N, and
-- every count (charts, totals, issues) adds the weight instead of 1.
ALTER TABLE request_events ADD COLUMN weight smallint NOT NULL DEFAULT 1;
ALTER TABLE log_events ADD COLUMN weight smallint NOT NULL DEFAULT 1;
