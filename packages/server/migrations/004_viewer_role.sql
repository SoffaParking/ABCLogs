-- Viewers see everything members see and change nothing: no resolving or
-- ignoring issues. For people outside the team who should only look.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'member', 'viewer'));
ALTER TABLE invites DROP CONSTRAINT invites_role_check;
ALTER TABLE invites ADD CONSTRAINT invites_role_check CHECK (role IN ('admin', 'member', 'viewer'));
