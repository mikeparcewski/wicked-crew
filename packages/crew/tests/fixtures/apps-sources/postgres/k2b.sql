-- DES-APPS-001 K2b: what the write path and the P1-P43 regression suite add on top of seed.sql. Applied by a
-- superuser right after it, to the same fresh database. The writer logins are cluster-wide (created if missing).
DO $$ BEGIN CREATE ROLE apps_k2b_writer LOGIN PASSWORD 'apps-k2b-writer'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE apps_k2b_colwriter LOGIN PASSWORD 'apps-k2b-colwriter'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE apps_k2b_inserter LOGIN PASSWORD 'apps-k2b-inserter'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE apps_k2b_repl LOGIN PASSWORD 'apps-k2b-repl'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE apps_k2b_repl SET session_replication_role = replica;                                       -- P26
GRANT USAGE ON SCHEMA s TO apps_k2b_writer, apps_k2b_colwriter, apps_k2b_inserter, apps_k2b_repl;
-- (s.side gets no grant: every side write in the suite runs as the superuser or a SECURITY DEFINER function,
-- and K1's read-only privilege report for apps_reader must stay read-only.)

-- The positive tables: an update target with three columns (P43a), and a table with no foreign keys for
-- inserts and deletes, with a typmod column (P28) and crew-filled values.
CREATE TABLE s.tickets (id int PRIMARY KEY, owner text, region text);
INSERT INTO s.tickets VALUES (4821, 'nobody', 'EMEA'), (4822, 'nobody', 'AMER'), (4823, 'nobody', 'APAC');
CREATE TABLE s.notes (id uuid PRIMARY KEY, body text NOT NULL, created_at timestamptz NOT NULL, amount numeric(3,1));
INSERT INTO s.notes VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'first', '2026-11-01T00:00:00Z', 1.5);
GRANT SELECT, UPDATE ON s.tickets TO apps_k2b_writer, apps_k2b_repl;
GRANT SELECT, INSERT, UPDATE, DELETE ON s.notes TO apps_k2b_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON s.catdef, s.t6, s.t2, s.money, s.w, s.trig, s.t, s.enumd, s.kid, s.par TO apps_k2b_writer;

-- P11 / P36: column-level grants only. P42: an insert-only login.
GRANT SELECT (id, owner), UPDATE (owner) ON s.tickets TO apps_k2b_colwriter;
GRANT SELECT, INSERT ON s.notes TO apps_k2b_inserter;

-- P27: a deferred foreign key.
CREATE TABLE s.dpar (id int PRIMARY KEY); INSERT INTO s.dpar VALUES (1);
CREATE TABLE s.dkid (id int PRIMARY KEY, par_id int REFERENCES s.dpar(id) DEFERRABLE INITIALLY DEFERRED);
GRANT SELECT, INSERT ON s.dkid TO apps_k2b_writer, apps_k2b_repl;
GRANT SELECT ON s.dpar TO apps_k2b_writer, apps_k2b_repl;

-- P30 / P38 / P43b: the swap targets live in their own schemas, created and renamed by the tests.
ANALYZE;
