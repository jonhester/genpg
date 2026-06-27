# genpg

Type-safe TypeScript from SQL queries for PostgreSQL — like [sqlc](https://sqlc.dev), but for TypeScript.

You write plain SQL in `.sql` files with a small annotation. `genpg` introspects a
real Postgres to learn the exact parameter and result types, then generates typed
TypeScript functions. By default it uses **[PGlite](https://pglite.dev)** (Postgres
compiled to WASM) in-process, so **no database server is required** — codegen runs
anywhere, including CI, with zero services.

## Features

- **Accurate types** — types come from Postgres itself (Parse/Describe), not a SQL parser, so joins, expressions, functions, enums, arrays, and domains all resolve correctly.
- **Correct nullability** — `NOT NULL` columns are non-nullable; everything else is `T | null`.
- **Named parameters** — write `@id`, get a typed `{ id: ... }` args object. Repeated names reuse one positional placeholder.
- **No database server needed** — schema is introspected in-process via PGlite; nothing to stand up, even in CI.
- **Schema from a file or dbmate-style migrations** — no dump required.
- **Driver-agnostic output** — generated code targets a tiny `Queryable` interface; works directly with `pg`, or via an adapter with `postgres.js`.

## Install

```sh
npm install --save-dev genpg
```

## Quick start

**1. Describe your schema** (`db/schema.sql`):

```sql
CREATE TYPE account_status AS ENUM ('active', 'suspended', 'closed');

CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  full_name  text,
  status     account_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**2. Write queries** (`db/queries/users.sql`):

```sql
-- name: GetUser :one
SELECT id, email, full_name, status FROM users WHERE id = @id;

-- name: ListUsersByStatus :many
SELECT id, email FROM users WHERE status = @status ORDER BY created_at DESC;

-- name: CreateUser :one
INSERT INTO users (email, full_name) VALUES (@email, @full_name)
RETURNING id, email, created_at;
```

**3. Configure** (`genpg.json`):

```json
{
  "schema": "db/schema.sql",
  "queries": "db/queries/**/*.sql",
  "out": "src/db/queries.ts"
}
```

**4. Generate:**

```sh
npx genpg
```

**5. Use the typed functions:**

```ts
import { Pool } from "pg";
import { getUser, createUser } from "./db/queries.ts";

const pool = new Pool();

// `pg`'s Pool/Client already satisfy the Queryable interface.
const user = await getUser(pool, { id: 1n.toString() });
//    ^? GetUserRow | null  ->  { id: string; email: string; full_name: string | null;
//                               status: "active" | "suspended" | "closed" }

const created = await createUser(pool, { email: "a@b.com", full_name: "Ada" });
```

## Query annotations

Each query is introduced by a marker comment: `-- name: <Name> :<command>`.

| Command     | Returns                  |
| ----------- | ------------------------ |
| `:one`      | `Row \| null`            |
| `:many`     | `Row[]`                  |
| `:exec`     | `void`                   |
| `:execrows` | `number` (affected rows) |

### Named parameters

Write `@name` anywhere a value goes. The generated function takes a typed object,
and Postgres infers each parameter's type:

```sql
-- name: SearchUsers :many
SELECT id, email FROM users
WHERE status = @status AND email ILIKE @pattern;
```

```ts
await searchUsers(db, { status: "active", pattern: "%@example.com" });
```

Reusing a name (`@id ... @id`) maps to a single positional placeholder. Parameters
inside string literals, comments, and dollar-quoted blocks are left alone, so
operators like `@>` are safe.

#### Markers

| Syntax          | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `@name`         | scalar, **non-null** (default)                                         |
| `@name!`        | scalar, non-null (explicit)                                            |
| `@name?`        | scalar, **nullable** → `name: T \| null`                               |
| `@name(array)`  | array param, expanded to `($1, $2, …)` at runtime — for `IN (…)` lists |
| `@name(spread)` | bulk-insert rows, expanded to `($1,$2),($3,$4),…`                      |

**Array params** are for `IN` lists. The arg is a typed array; genpg builds the
placeholder list per call. An empty array becomes `IN (NULL)` (matches nothing):

```sql
-- name: UsersByIds :many
SELECT id, email FROM users WHERE id IN @ids(array);
```

```ts
await usersByIds(db, { ids: [1, 2, 3] }); // arg type: { ids: number[] }
```

> For array **membership** you can also skip the marker entirely and use
> `WHERE id = ANY(@ids)` — Postgres accepts a single array param there, no
> runtime expansion needed.

**Spread params** are for bulk inserts. Use `INSERT INTO t (cols…) VALUES @rows(spread)`;
the row shape is taken from the column list. An empty array short-circuits (no query):

```sql
-- name: BulkCreateUsers :execrows
INSERT INTO users (email, full_name) VALUES @rows(spread);
```

```ts
await bulkCreateUsers(db, { rows: [{ email, full_name }, …] });
// arg type: { rows: { email: string; full_name: string }[] }
```

## Schema source: file or migrations

Use a single schema file:

```json
{ "schema": "db/schema.sql", "queries": "db/queries/**/*.sql", "out": "src/db/queries.ts" }
```

…or a [dbmate](https://github.com/amacneil/dbmate)-style migrations directory (no
dump needed — the `-- migrate:up` blocks are applied in filename order):

```json
{ "migrations": "db/migrations", "queries": "db/queries/**/*.sql", "out": "src/db/queries.ts" }
```

Your schema/migrations are applied to a fresh **in-process** Postgres ([PGlite](https://pglite.dev))
each run, so the generated types always match your migration files — no database
server, no connection string, no drift.

## Use it in CI

Commit the generated file and verify it stays in sync — no services to start:

```sh
npx genpg && git diff --exit-code src/db/queries.ts
```

If a query or the schema changed without regenerating, the `git diff` fails the build.

## Drivers

Generated functions take a minimal `Queryable` (`{ query(text, values) }`).

- **node-postgres (`pg`)** — a `Client` or `Pool` _is_ a `Queryable`; pass it directly.
- **postgres.js** — wrap it with the adapter:

  ```ts
  import postgres from "postgres";
  import { fromPostgresJs } from "genpg/runtime";

  const sql = postgres();
  const db = fromPostgresJs(sql);
  await getUser(db, { id: "1" });
  ```

## Transactions

Because every function accepts a `Queryable`, a transaction is just "pass a
transaction-scoped connection." Helpers are provided for both drivers:

```ts
import { withTransaction } from "genpg/runtime";

await withTransaction(pool, async (tx) => {
  const user = await createUser(tx, { email, full_name });
  await updateStatus(tx, { id: user.id, status: "active" });
}); // COMMIT on success, ROLLBACK on throw
```

```ts
import { withPostgresJsTransaction } from "genpg/runtime";

await withPostgresJsTransaction(sql, async (tx) => {
  await createUser(tx, { email, full_name });
});
```

## Type mapping

Types mirror how `pg` deserializes values by default:

| PostgreSQL                         | TypeScript                |
| ---------------------------------- | ------------------------- |
| `bool`                             | `boolean`                 |
| `int2`, `int4`, `oid`, `float4/8`  | `number`                  |
| `int8` (bigint), `numeric`         | `string`                  |
| `text`, `varchar`, `uuid`, …       | `string`                  |
| `date`, `timestamp`, `timestamptz` | `Date`                    |
| `json`, `jsonb`                    | `unknown`                 |
| `bytea`                            | `Buffer`                  |
| enum                               | string-literal union      |
| `T[]`                              | `T'[]` (element resolved) |
| domain                             | its base type             |

## Custom type mapping

Map Postgres type names to your own TypeScript types via `overrides`. A value is
either a type string, or `{ "type": ..., "import": ... }` to also emit an import.

```json
{
  "schema": "db/schema.sql",
  "queries": "db/queries/**/*.sql",
  "out": "src/db/queries.ts",
  "overrides": {
    "timestamptz": "Temporal.Instant",
    "timestamp": "Temporal.PlainDateTime",
    "date": "Temporal.PlainDate",
    "time": "Temporal.PlainTime",
    "numeric": { "type": "Decimal", "import": "import { Decimal } from 'decimal.js';" }
  }
}
```

Overrides are keyed by **Postgres type name** (`timestamptz`, `numeric`, a user
enum/domain name, …), win over the built-ins, and apply everywhere the type
appears — including inside arrays (`date[]` → `Temporal.PlainDate[]`) and domains.

### Making values actually convert at runtime

A bare override is only a _type-level_ claim — at runtime you'd still get the
driver's value (a `Date`, not a `Temporal.Instant`), which silently breaks. Add
`parse`/`serialize` and **genpg wires the conversion into the generated code**, so
there is nothing to call at startup and nothing to forget:

```json
{
  "overrides": {
    "timestamptz": {
      "type": "Temporal.Instant",
      "import": "import { Temporal } from 'temporal-polyfill';",
      "parse": "(value) => value.toTemporalInstant()",
      "serialize": "(value) => value.toString()"
    }
  }
}
```

- **`parse`** (`(value) => T`, receiving the driver's value) — genpg **hydrates**
  each result row, converting the column (and array/null) in the query function
  itself:

  ```ts
  // generated:
  function hydrateGetUserRow(r) {
    return { ...r, created_at: r.created_at == null ? null : __parse_timestamptz(r.created_at) };
  }
  ```

- **`serialize`** (`(value: T) => unknown`) — genpg wraps the value at every call
  site where this type is a parameter, so you pass a `Temporal.Instant` directly:

  ```ts
  await listCreatedSince(db, { since: Temporal.Now.instant() });
  // generated: db.query(sql, [args.since == null ? null : __ser_timestamptz(args.since)])
  ```

### Safety: you get a warning before it breaks

genpg knows which queries use a type as a result vs. a param, so if an override is
missing the converter for a direction it's actually used in, **codegen warns** (with
the exact reason) instead of letting it fail at runtime:

```
! override "timestamptz" -> Temporal.Instant is used as a parameter but has no
  `serialize`; passing a Temporal.Instant will likely fail at runtime.
```

For overrides that genuinely need no conversion — a branded alias like
`uuid → UserId` (structurally a string), or a type whose driver parser you wire
yourself — declare the intent and the warning goes away:

```json
"uuid": { "type": "UserId", "runtime": "none" }
```

genpg never _invents_ the conversion (`parse`/`serialize` are the one-liners you
supply), but everything downstream is generated and checked. The one thing it can't
help with is a `parse` for a **user-defined** type — its OID isn't stable across
databases — but enums need no parser (they round-trip as their string labels), so in
practice `parse` is for built-in scalars (`timestamptz`, `numeric`, …).

## Programmatic API

```ts
import { generateFromConfigFile, generateFromConfig } from "genpg";

const { code, count, errors } = await generateFromConfigFile("genpg.json");
```

## License

MIT
