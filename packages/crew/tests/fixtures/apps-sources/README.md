# Apps source fixtures (DES-APPS-001)

Shared by the Apps lanes (K1 sources, K2b executor and writes, K6 app server, the E2E runs).

| Path | What |
|---|---|
| `postgres/seed.sql` | A superuser applies it to a fresh database: schema `s` with every probe table of the row-write design (P1-P43 setups K1 needs; K2b adds its own), the read logins `apps_reader`, `apps_writer`, `apps_bare`, and `s.big` for deadline tests. |
| `postgres/k2b.sql` | Applied right after `seed.sql` (K2b): the writer logins (`apps_k2b_writer` with table-level grants, `apps_k2b_colwriter` column-level only, `apps_k2b_inserter` insert-only, `apps_k2b_repl` with `session_replication_role = replica`), `s.tickets` (three columns), `s.notes` (no foreign keys, a `numeric(3,1)`), and a deferred foreign key (`s.dkid`). |
| `mysql/seed.sql` | Applied as root to a fresh database (`{{db}}` replaced): `refunds` (with an ENUM), `ledger` (a foreign key), the view `pending`, and `big`. |
| `servers.mjs` | `startOpenApiService()` (nested paginated `GET /v1/tickets`, a `POST …/assign` write, `/openapi.json`), `startGraphqlServer()` (`/graphql`, enum `Status`, a mutation), `startMcpServer()` (the reference MCP server at `/mcp`: `list_tickets` read, `assign_ticket` write). Each records `hits`. |
| `uploads/*.csv` | A CSV with a header and one without. |
| `uploads/make.mjs` | Binary samples made at test time: `makeXlsx(rows)`, `makeZipBomb(mb)`, `makeSqlite(path, {trigger, view})`. |

CI (`.github/workflows/ci.yml`, job `sources-db`) runs Postgres 16, Postgres 17 and MySQL 8 as service
containers and sets `APPS_PG16_URL`, `APPS_PG17_URL`, `APPS_MYSQL8_URL` and `WICKED_SOURCES_DB=required`.
Without those variables the real-database tests skip and say so; with `WICKED_SOURCES_DB=required` a
missing database fails them.

Locally (rancher-desktop docker):

```sh
docker run -d --name apps-pg16 -e POSTGRES_PASSWORD=apps -p 127.0.0.1:55416:5432 postgres:16-alpine
docker run -d --name apps-pg17 -e POSTGRES_PASSWORD=apps -p 127.0.0.1:55417:5432 postgres:17-alpine
docker run -d --name apps-mysql8 -e MYSQL_ROOT_PASSWORD=apps -p 127.0.0.1:53308:3306 mysql:8.4
APPS_PG16_URL=postgres://postgres:apps@127.0.0.1:55416/postgres \
APPS_PG17_URL=postgres://postgres:apps@127.0.0.1:55417/postgres \
APPS_MYSQL8_URL=mysql://root:apps@127.0.0.1:53308/mysql \
  npx vitest run tests/sources-
```
