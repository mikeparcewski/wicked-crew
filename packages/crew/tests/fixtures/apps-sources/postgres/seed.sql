-- DES-APPS-001 shared fixture: the Postgres source K1 describes, reads and safety-checks, and K2b reuses
-- for the P1-P43 regression suite. Applied by a superuser to a FRESH database (tests create one per
-- run). Table names follow the probe scripts (lanes/data-builder-design/review/pgwrite-probe*.sh);
-- the probe number is noted on each. Roles are cluster-wide, so they are created only if missing.
DO $$ BEGIN CREATE ROLE apps_reader LOGIN PASSWORD 'apps-reader'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE apps_writer LOGIN PASSWORD 'apps-writer'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE apps_bare LOGIN PASSWORD 'apps-bare'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA s;
CREATE TABLE s.side (note text);
CREATE TYPE s.prio AS ENUM ('low', 'high');

-- P1: the base set
CREATE TABLE s.plain (id int PRIMARY KEY, owner text, prio s.prio, amount numeric(10,2));
INSERT INTO s.plain VALUES (1, 'a', 'low', 1.00), (2, 'b', 'high', 2.00);
CREATE FUNCTION s.bump() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN INSERT INTO s.side VALUES ('trigger ran'); NEW.owner := NEW.owner || '-changed'; RETURN NEW; END $t$;
CREATE TABLE s.trig (LIKE s.plain INCLUDING ALL); INSERT INTO s.trig VALUES (1, 'a', 'low', 1);
CREATE TRIGGER t1 BEFORE UPDATE ON s.trig FOR EACH ROW EXECUTE FUNCTION s.bump();
CREATE TABLE s.ruled (LIKE s.plain INCLUDING ALL); INSERT INTO s.ruled VALUES (1, 'a', 'low', 1);
CREATE RULE r1 AS ON UPDATE TO s.ruled DO ALSO INSERT INTO s.side VALUES ('rule ran');
CREATE TABLE s.parent (id int PRIMARY KEY, owner text); CREATE TABLE s.child () INHERITS (s.parent);
CREATE TABLE s.parted (id int, owner text, PRIMARY KEY (id)) PARTITION BY RANGE (id);
CREATE TABLE s.parted_1 PARTITION OF s.parted FOR VALUES FROM (0) TO (100);
CREATE TABLE s.rls (LIKE s.plain INCLUDING ALL); ALTER TABLE s.rls ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON s.rls FOR ALL USING (owner = current_user);
CREATE TABLE s.kids (id int PRIMARY KEY, parent_id int REFERENCES s.plain(id) ON DELETE CASCADE);  -- s.plain: cascading key (P8)
CREATE FUNCTION s.mkdefault() RETURNS text LANGUAGE sql AS $d$ SELECT 'x' $d$;
CREATE TABLE s.defaulted (id int PRIMARY KEY, owner text DEFAULT s.mkdefault());                   -- accepted: a default never runs (P35)
CREATE FUNCTION s.ok(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $d$ SELECT true $d$;
CREATE TABLE s.checked (id int PRIMARY KEY, owner text CHECK (s.ok(owner)));
CREATE DOMAIN s.email AS text CHECK (VALUE LIKE '%@%');
CREATE TABLE s.domained (id int PRIMARY KEY, owner s.email);
CREATE VIEW s.v AS SELECT * FROM s.plain;
CREATE TABLE s.w (id int PRIMARY KEY, owner text); INSERT INTO s.w VALUES (4821, 'nobody'), (4822, 'nobody');
CREATE TABLE s.enumd (id int PRIMARY KEY, prio s.prio NOT NULL);                                    -- accepted: an enum column

-- P12: a default through a custom operator (accepted), a generated column, a disabled trigger (P13)
CREATE FUNCTION s.cat3(text, text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT $1 || $2 || '!' $f$;
CREATE OPERATOR s.||| (LEFTARG = text, RIGHTARG = text, FUNCTION = s.cat3);
CREATE TABLE s.opdef (id int PRIMARY KEY, owner text DEFAULT ('a' OPERATOR(s.|||) 'b'));
CREATE TABLE s.gen (id int PRIMARY KEY, owner text, shout text GENERATED ALWAYS AS (s.cat3(owner, 'x')) STORED);
CREATE TABLE s.dis (id int PRIMARY KEY, owner text);
CREATE FUNCTION s.tf() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$;
CREATE TRIGGER t BEFORE UPDATE ON s.dis FOR EACH ROW EXECUTE FUNCTION s.tf();
ALTER TABLE s.dis DISABLE TRIGGER t;

-- P14-P19
CREATE FUNCTION s.vol(text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $f$ BEGIN INSERT INTO s.side VALUES ('ran: ' || $1); RETURN true; END $f$;
CREATE FUNCTION s.evil(text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN s.vol($1); END $f$;
CREATE TABLE s.idx (id int PRIMARY KEY, owner text); CREATE INDEX ON s.idx ((s.evil(owner)));            -- P14
CREATE TABLE s.pidx (id int PRIMARY KEY, owner text); CREATE INDEX ON s.pidx (owner) WHERE s.evil(owner); -- P15
CREATE DOMAIN s.did AS int CHECK (s.vol(VALUE::text));
CREATE TABLE s.dkey (id s.did PRIMARY KEY, owner text);                                                  -- P16
CREATE DOMAIN s.dtext AS text CHECK (s.vol(VALUE));
CREATE TABLE s.ccast (id int PRIMARY KEY, owner text CHECK (owner::s.dtext IS NOT NULL));               -- P17
CREATE TABLE s.catdef (id int PRIMARY KEY, owner text, n oid DEFAULT pg_catalog.lo_from_bytea(0, 'x'::bytea)); -- P18: accepted
CREATE TABLE s.bicheck (id int PRIMARY KEY, n oid CHECK (pg_catalog.lo_from_bytea(0, 'x'::bytea) IS NOT NULL)); -- side-effecting built-in in a CHECK
CREATE TABLE s.par (id int PRIMARY KEY); CREATE TABLE s.kid (id int PRIMARY KEY, par_id int REFERENCES s.par(id));
ALTER TABLE s.par DISABLE TRIGGER ALL;                                                                    -- P19
CREATE TABLE s.money (id int PRIMARY KEY, amount numeric(10,2), code varchar(3), ratio real);             -- P28/P31

-- P24: a trigger that removes itself
CREATE TABLE s.t (id int PRIMARY KEY, owner text); INSERT INTO s.t VALUES (1, 'a'), (2, 'b');
CREATE FUNCTION s.selfdrop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $t$ BEGIN INSERT INTO s.side VALUES ('late ran'); EXECUTE 'DROP TRIGGER late ON s.t'; RETURN NEW; END $t$;
CREATE TRIGGER late BEFORE UPDATE ON s.t FOR EACH ROW EXECUTE FUNCTION s.selfdrop();

-- P29, P33, P34: foreign keys and the operations that would run their enforcement
CREATE TABLE s.p6 (id int PRIMARY KEY); INSERT INTO s.p6 VALUES (1), (2);
CREATE INDEX p6_evil ON s.p6 (id) WHERE s.evil('7');
CREATE TABLE s.t6 (id int PRIMARY KEY, par_id int REFERENCES s.p6(id), owner text); INSERT INTO s.t6 VALUES (1, 1, 'a');
CREATE TABLE s.t2 (id int PRIMARY KEY, owner text); INSERT INTO s.t2 VALUES (1, 'a'), (2, 'b');
CREATE TABLE s.c6 (id int PRIMARY KEY, t2_id int REFERENCES s.t2(id)); INSERT INTO s.c6 VALUES (10, 1);

-- P37 (a user cast on an enum, run from a CHECK that prints as a plain ::text) is NOT here: a cast is
-- database-wide, and a user cast to text touches every table with a text column (DES §7.4 refuses a
-- user cast to or from any column type). Tests create it inside a transaction they roll back.

-- P39: a foreign key comparing with a custom equality operator
CREATE FUNCTION s.ieq(int, int) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $f$ BEGIN INSERT INTO s.side VALUES ('eq ran'); RETURN $1 = $2; END $f$;
CREATE OPERATOR s.= (LEFTARG = int, RIGHTARG = int, FUNCTION = s.ieq, COMMUTATOR = OPERATOR(s.=));
CREATE OPERATOR CLASS s.int_ops FOR TYPE int USING btree AS
  OPERATOR 1 pg_catalog.<, OPERATOR 2 pg_catalog.<=, OPERATOR 3 s.=, OPERATOR 4 pg_catalog.>=, OPERATOR 5 pg_catalog.>, FUNCTION 1 pg_catalog.btint4cmp(int, int);
CREATE TABLE s.regions (id int NOT NULL); INSERT INTO s.regions VALUES (1), (2);
CREATE UNIQUE INDEX regions_id ON s.regions (id s.int_ops);
-- (P39) the foreign key below references the unique index itself: a primary key cannot use a non-default operator class
CREATE TABLE s.tickets9 (id int PRIMARY KEY, region_id int REFERENCES s.regions(id), owner text);

-- P40: extended statistics with an expression
CREATE FUNCTION s.vol2(text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $f$ BEGIN INSERT INTO s.side VALUES ('stats expr ran'); RETURN $1; END $f$;
CREATE FUNCTION s.fake(text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN s.vol2($1); END $f$;
CREATE TABLE s.tickets10 (id int PRIMARY KEY, owner text);
CREATE STATISTICS s.st10 ON id, owner, (s.fake('constant')) FROM s.tickets10;

-- Reads: a table for the deadline test (a cross join of it runs for minutes), and the read logins.
CREATE TABLE s.big (n int PRIMARY KEY); INSERT INTO s.big SELECT g FROM generate_series(1, 4000) g;
ANALYZE;
GRANT USAGE ON SCHEMA s TO apps_reader, apps_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA s TO apps_reader;
GRANT SELECT (id, owner), UPDATE (owner) ON s.w TO apps_writer;   -- the privilege report: table-level SELECT and UPDATE missing
GRANT SELECT, UPDATE ON s.t2 TO apps_writer;                        -- complete for an update
