import { expect, test } from "vite-plus/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { PgEngine } from "../src/engine.ts";
import { analyzeQueries } from "../src/introspect.ts";
import { parseQueryFile } from "../src/sqlfile.ts";
import { generateModule } from "../src/codegen.ts";
import { generateFromConfig } from "../src/index.ts";

const connection = process.env.TEST_DATABASE_URL;
const dbTest = test.skipIf(!connection);

const SCHEMA = `
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE TABLE users (
  id        serial PRIMARY KEY,
  email     text NOT NULL,
  nickname  text,
  mood      mood,
  tags      text[],
  created   timestamptz NOT NULL DEFAULT now()
);
`;

const QUERIES = `
-- name: GetUser :one
SELECT id, email, nickname, mood, tags, created FROM users WHERE id = @id;

-- name: ListByMood :many
SELECT id, email FROM users WHERE mood = @mood ORDER BY id;

-- name: InsertUser :execrows
INSERT INTO users (email, nickname) VALUES (@email, @nickname);

-- name: DeleteUser :exec
DELETE FROM users WHERE id = @id;
`;

dbTest("end-to-end introspection + codegen against PostgreSQL", async () => {
  const engine = await PgEngine.create(connection!);
  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      queries: parseQueryFile(QUERIES),
      schema: SCHEMA,
    });

    expect(errors).toEqual([]);
    expect(analyzed.length).toBe(4);

    const code = generateModule(analyzed, { typeInfo, notNull });

    // Result row interface with correct nullability and types.
    expect(code).toContain("export interface GetUserRow {");
    expect(code).toContain("id: number;"); // serial PK, NOT NULL
    expect(code).toContain("email: string;"); // NOT NULL
    expect(code).toContain("nickname: string | null;"); // nullable
    expect(code).toContain("created: Date;"); // timestamptz NOT NULL -> Date
    expect(code).toContain("tags: string[] | null;"); // text[] nullable

    // Enum resolves to a string-literal union.
    expect(code).toContain('"sad" | "ok" | "happy"');

    // Named params become a typed args object.
    expect(code).toContain("export interface GetUserArgs {\n  id: number;\n}");
    expect(code).toContain(
      "export async function getUser(db: Queryable, args: GetUserArgs): Promise<GetUserRow | null>",
    );

    // Commands map to the right return shapes.
    expect(code).toContain(
      "export async function listByMood(db: Queryable, args: ListByMoodArgs): Promise<ListByMoodRow[]>",
    );
    expect(code).toContain(
      "export async function insertUser(db: Queryable, args: InsertUserArgs): Promise<number>",
    );
    expect(code).toContain(
      "export async function deleteUser(db: Queryable, args: DeleteUserArgs): Promise<void>",
    );

    // exec/execrows do not emit a row interface.
    expect(code).not.toContain("InsertUserRow");
    expect(code).not.toContain("DeleteUserRow");
  } finally {
    await engine.dispose();
  }
});

dbTest("infers obvious non-null COALESCE output from query expressions and views", async () => {
  const suffix = process.pid;
  const workspaces = `genpg_nullability_workspaces_${suffix}`;
  const bucketTypes = `genpg_nullability_bucket_types_${suffix}`;
  const buckets = `genpg_nullability_buckets_${suffix}`;
  const view = `genpg_nullability_view_${suffix}`;
  const engine = await PgEngine.create(connection!);
  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      schema: `
        CREATE TABLE ${workspaces} (
          id int PRIMARY KEY,
          note text
        );

        CREATE TABLE ${bucketTypes} (
          code text PRIMARY KEY,
          name text NOT NULL
        );

        CREATE TABLE ${buckets} (
          workspace_id int NOT NULL REFERENCES ${workspaces}(id),
          bucket_type text NOT NULL REFERENCES ${bucketTypes}(code),
          planned_cents bigint
        );

        CREATE VIEW ${view} AS
        SELECT
          w.id AS workspace_id,
          bt.code AS bucket_type,
          bt.name,
          COALESCE(wb.planned_cents, 0) AS planned_cents,
          wb.planned_cents AS raw_planned_cents,
          w.note
        FROM ${workspaces} w
        CROSS JOIN ${bucketTypes} bt
        LEFT JOIN ${buckets} wb
          ON wb.workspace_id = w.id AND wb.bucket_type = bt.code;
      `,
      queries: parseQueryFile(`
        -- name: FromExpression :one
        SELECT COALESCE(planned_cents, 0) AS planned_cents, planned_cents FROM ${buckets};

        -- name: FromView :one
        SELECT workspace_id, bucket_type, name, planned_cents, raw_planned_cents, note FROM ${view};
      `),
    });

    expect(errors).toEqual([]);
    const code = generateModule(analyzed, { typeInfo, notNull });

    expect(code).toContain("export interface FromExpressionRow {\n  planned_cents: string;");
    expect(code).toContain("export interface FromViewRow {");
    expect(code).toContain("workspace_id: number;");
    expect(code).toContain("bucket_type: string;");
    expect(code).toContain("name: string;");
    expect(code).toContain("planned_cents: string;");
    expect(code).toContain("raw_planned_cents: string | null;");
    expect(code).toContain("note: string | null;");
  } finally {
    await engine.dispose();
  }
});

dbTest("infers nullability through a materialized view", async () => {
  const suffix = process.pid;
  const base = `genpg_matview_base_${suffix}`;
  const opt = `genpg_matview_opt_${suffix}`;
  const mview = `genpg_matview_${suffix}`;
  const engine = await PgEngine.create(connection!);
  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      schema: `
        CREATE TABLE ${base} (
          id    int PRIMARY KEY,
          label text NOT NULL
        );
        CREATE TABLE ${opt} (
          base_id int NOT NULL REFERENCES ${base}(id),
          note    text NOT NULL
        );
        CREATE MATERIALIZED VIEW ${mview} AS
        SELECT b.id AS id, b.label AS label, o.note AS note
        FROM ${base} b
        LEFT JOIN ${opt} o ON o.base_id = b.id;
      `,
      queries: parseQueryFile(`
        -- name: FromMatview :many
        SELECT id, label, note FROM ${mview} ORDER BY id;
      `),
    });

    expect(errors).toEqual([]);
    const code = generateModule(analyzed, { typeInfo, notNull });
    // relkind 'm' is inferred the same way as a plain view (pg_get_viewdef).
    expect(code).toContain("id: number;"); // NOT NULL passthrough
    expect(code).toContain("label: string;"); // NOT NULL passthrough
    expect(code).toContain("note: string | null;"); // LEFT-join side -> nullable
  } finally {
    await engine.dispose();
  }
});

dbTest("stays conservative through a nested view (view of a view)", async () => {
  const suffix = process.pid;
  const base = `genpg_nested_base_${suffix}`;
  const inner = `genpg_nested_inner_${suffix}`;
  const outer = `genpg_nested_outer_${suffix}`;
  const engine = await PgEngine.create(connection!);
  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      schema: `
        CREATE TABLE ${base} (
          id    int PRIMARY KEY,
          label text NOT NULL
        );
        CREATE VIEW ${inner} AS
        SELECT b.id AS id, b.label AS label, b.label || '!' AS shout
        FROM ${base} b;
        CREATE VIEW ${outer} AS
        SELECT i.id AS id, i.label AS label, i.shout AS shout
        FROM ${inner} i;
      `,
      queries: parseQueryFile(`
        -- name: FromNested :many
        SELECT id, label, shout FROM ${outer} ORDER BY id;
      `),
    });

    expect(errors).toEqual([]);
    const code = generateModule(analyzed, { typeInfo, notNull });
    // The outer view's columns come from the INNER view, whose attnotnull is
    // always false; lineage is not chased through nested views, so they stay
    // nullable even though the base columns are NOT NULL. Conservative + safe.
    expect(code).toContain("export interface FromNestedRow {");
    expect(code).toContain("id: number | null;");
    expect(code).toContain("label: string | null;");
    expect(code).toContain("shout: string | null;");
  } finally {
    await engine.dispose();
  }
});

dbTest("propagates RIGHT/FULL JOIN nullability in a view", async () => {
  const suffix = process.pid;
  const left = `genpg_rj_left_${suffix}`;
  const right = `genpg_rj_right_${suffix}`;
  const rview = `genpg_rj_right_view_${suffix}`;
  const fview = `genpg_rj_full_view_${suffix}`;
  const engine = await PgEngine.create(connection!);
  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      schema: `
        CREATE TABLE ${left} (
          id    int PRIMARY KEY,
          lname text NOT NULL
        );
        CREATE TABLE ${right} (
          id      int PRIMARY KEY,
          left_id int,
          rname   text NOT NULL
        );
        CREATE VIEW ${rview} AS
        SELECT l.lname AS lname, r.rname AS rname
        FROM ${left} l
        RIGHT JOIN ${right} r ON r.left_id = l.id;
        CREATE VIEW ${fview} AS
        SELECT l.lname AS lname, r.rname AS rname
        FROM ${left} l
        FULL JOIN ${right} r ON r.left_id = l.id;
      `,
      queries: parseQueryFile(`
        -- name: FromRightView :many
        SELECT lname, rname FROM ${rview};

        -- name: FromFullView :many
        SELECT lname, rname FROM ${fview};
      `),
    });

    expect(errors).toEqual([]);
    const code = generateModule(analyzed, { typeInfo, notNull });
    // RIGHT JOIN: the left side becomes nullable, the preserved right side stays non-null.
    expect(code).toContain(
      "export interface FromRightViewRow {\n  lname: string | null;\n  rname: string;\n}",
    );
    // FULL JOIN: both sides become nullable.
    expect(code).toContain(
      "export interface FromFullViewRow {\n  lname: string | null;\n  rname: string | null;\n}",
    );
  } finally {
    await engine.dispose();
  }
});

dbTest("infers obvious non-null generated column expressions", async () => {
  const table = `genpg_generated_nullability_${process.pid}`;
  const engine = await PgEngine.create(connection!);
  try {
    const [version] = await engine.queryRows("SHOW server_version_num");
    if (Number(version.server_version_num) < 120000) return;

    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      schema: `
        CREATE TABLE ${table} (
          id int PRIMARY KEY,
          monthly_cents bigint,
          normalized_monthly_cents bigint
            GENERATED ALWAYS AS (COALESCE(monthly_cents, 0)::bigint) STORED,
          maybe_monthly_cents bigint
            GENERATED ALWAYS AS (monthly_cents + 1) STORED
        );
      `,
      queries: parseQueryFile(`
        -- name: GeneratedAmounts :one
        SELECT normalized_monthly_cents, maybe_monthly_cents FROM ${table};
      `),
    });

    expect(errors).toEqual([]);
    const code = generateModule(analyzed, { typeInfo, notNull });
    expect(code).toContain("normalized_monthly_cents: string;");
    expect(code).toContain("maybe_monthly_cents: string | null;");
  } finally {
    await engine.dispose();
  }
});

dbTest("keeps direct-query expressions conservative but honors -- nonnull:", async () => {
  const table = `genpg_expression_nullability_${process.pid}`;
  const engine = await PgEngine.create(connection!);
  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      schema: `
        CREATE TABLE ${table} (
          id int PRIMARY KEY,
          first_name text NOT NULL,
          last_name text NOT NULL,
          nickname text,
          created_at timestamptz NOT NULL
        );
      `,
      queries: parseQueryFile(`
        -- name: ExpressionNames :one
        SELECT
          n.first_name || ' ' || n.last_name AS display_name,
          n.first_name || n.nickname AS maybe_name,
          date_trunc('month', n.created_at) AS created_month
        FROM ${table} n;

        -- name: ManualNonnull :one
        -- nonnull: nickname
        SELECT nickname FROM ${table};
      `),
    });

    expect(errors).toEqual([]);
    const code = generateModule(analyzed, { typeInfo, notNull });
    // Expressions in a direct query stay conservative (nullable) even when their
    // operands are NOT NULL: inferQueryNotNullColumns deliberately does not parse
    // arbitrary query select-lists. (View/generated-column lineage is inferred
    // separately; see the view + generated-column tests above.)
    expect(code).toContain("display_name: string | null;");
    expect(code).toContain("maybe_name: string | null;");
    expect(code).toContain("created_month: Date | null;");
    // The explicit `-- nonnull:` directive is the escape hatch that forces non-null.
    expect(code).toContain("export interface ManualNonnullRow {\n  nickname: string;");
  } finally {
    await engine.dispose();
  }
});

dbTest("type overrides apply by real Postgres type name (Temporal)", async () => {
  const engine = await PgEngine.create(connection!);
  try {
    const { analyzed, typeInfo, notNull } = await analyzeQueries({
      engine,
      queries: parseQueryFile(`
-- name: GetTimes :one
SELECT id, created, dates FROM users WHERE id = @id;
`),
      schema: `CREATE TABLE users (
        id      int PRIMARY KEY,
        created timestamptz NOT NULL,
        dates   date[]
      );`,
    });

    const code = generateModule(analyzed, {
      typeInfo,
      notNull,
      overrides: new Map([
        ["timestamptz", "Temporal.Instant"],
        ["date", "Temporal.PlainDate"],
      ]),
      imports: ["import { Temporal } from 'temporal-polyfill';"],
    });

    expect(code).toContain("import { Temporal } from 'temporal-polyfill';");
    expect(code).toContain("created: Temporal.Instant;");
    expect(code).toContain("dates: Temporal.PlainDate[] | null;"); // override through array
  } finally {
    await engine.dispose();
  }
});

dbTest("hydrates result rows and serializes params for runtime conversion", async () => {
  const engine = await PgEngine.create(connection!);
  try {
    const { analyzed, typeInfo, notNull } = await analyzeQueries({
      engine,
      queries: parseQueryFile(`
-- name: Since :many
SELECT id, created FROM events WHERE created >= @since;
`),
      schema: `CREATE TABLE events (id int PRIMARY KEY, created timestamptz NOT NULL);`,
    });

    const code = generateModule(analyzed, {
      typeInfo,
      notNull,
      overrides: new Map([["timestamptz", "Temporal.Instant"]]),
      imports: ["import { Temporal } from 'temporal-polyfill';"],
      parsers: new Map([["timestamptz", "(value) => value.toTemporalInstant()"]]),
      serializers: new Map([["timestamptz", "(value) => value.toString()"]]),
    });

    // Result direction: a per-row hydrator that converts the overridden column.
    expect(code).toContain("const __parse_timestamptz = (value) => value.toTemporalInstant();");
    expect(code).toContain("function hydrateSinceRow(r: any): SinceRow {");
    expect(code).toContain("created: r.created == null ? null : __parse_timestamptz(r.created),");
    expect(code).toContain("return result.rows.map(hydrateSinceRow);");

    // Param direction: a serializer const and a wrapped value at the call site.
    expect(code).toContain("const __ser_timestamptz = (value) => value.toString();");
    expect(code).toContain("[args.since == null ? null : __ser_timestamptz(args.since)]");

    // No driver registration to forget anymore.
    expect(code).not.toContain("applyTypeParsers");
  } finally {
    await engine.dispose();
  }
});

dbTest("generated hydration + serialization round-trips through PostgreSQL", async () => {
  // Override `text` so values are upper-cased on read and lower-cased on write.
  const schema = `CREATE TABLE t (id int PRIMARY KEY, full_name text NOT NULL);`;
  const queries = `
-- name: Insert :one
INSERT INTO t (id, full_name) VALUES (@id, @full_name) RETURNING id, full_name;

-- name: Get :one
SELECT id, full_name FROM t WHERE id = @id;
`;

  const engine = await PgEngine.create(connection!);
  let code: string;
  try {
    const { analyzed, typeInfo, notNull } = await analyzeQueries({
      engine,
      queries: parseQueryFile(queries),
      schema,
    });
    code = generateModule(analyzed, {
      typeInfo,
      notNull,
      overrides: new Map([["text", "string"]]),
      parsers: new Map([["text", "(value) => value.toUpperCase()"]]),
      serializers: new Map([["text", "(value) => value.toLowerCase()"]]),
      caseStyle: "camel",
    });
  } finally {
    await engine.dispose();
  }

  const dir = new URL("./__tmp__/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL(`hyd_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`, dir);
  await writeFile(file, code);

  const db = new Client({ connectionString: connection });
  await db.connect();
  await db.query("BEGIN");
  await db.query(schema);

  try {
    const mod: any = await import(file.href);
    // "Hello" -> serialized to "hello" on insert -> hydrated to "HELLO" on return.
    const inserted = await mod.insert(db, { id: 1, fullName: "Hello" });
    expect(inserted.fullName).toBe("HELLO");
    expect(inserted.full_name).toBeUndefined();
    // Stored value is the lower-cased "hello"; read hydrates it back to "HELLO".
    const got = await mod.get(db, { id: 1 });
    expect(got.fullName).toBe("HELLO");
    expect(got.full_name).toBeUndefined();
  } finally {
    await db.query("ROLLBACK");
    await db.end();
    await rm(dir, { recursive: true, force: true });
  }
});

dbTest("generated array + spread queries actually execute against PostgreSQL", async () => {
  const schema = `CREATE TABLE items (id int PRIMARY KEY, name text NOT NULL);`;
  const queries = `
-- name: InsertItems :execrows
INSERT INTO items (id, name) VALUES @rows(spread);

-- name: ByIds :many
SELECT id, name FROM items WHERE id IN @ids(array) ORDER BY id;
`;

  const engine = await PgEngine.create(connection!);
  let code: string;
  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      queries: parseQueryFile(queries),
      schema,
    });
    expect(errors).toEqual([]);
    code = generateModule(analyzed, { typeInfo, notNull });
  } finally {
    await engine.dispose();
  }

  // Write the generated module and import it for real execution.
  const dir = new URL("./__tmp__/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL(`gen_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`, dir);
  await writeFile(file, code);

  // Execute against the same PostgreSQL implementation used for introspection.
  const db = new Client({ connectionString: connection });
  await db.connect();
  await db.query("BEGIN");
  await db.query(schema);

  try {
    const mod: any = await import(file.href);

    // Bulk insert via spread.
    const inserted = await mod.insertItems(db, {
      rows: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
        { id: 3, name: "c" },
      ],
    });
    expect(inserted).toBe(3);

    // IN-list via array param.
    const some = await mod.byIds(db, { ids: [1, 3] });
    expect(some.map((r: any) => r.name)).toEqual(["a", "c"]);

    // Empty array -> IN (NULL) matches nothing (no SQL error).
    const none = await mod.byIds(db, { ids: [] });
    expect(none).toEqual([]);

    // Empty spread short-circuits without hitting the database.
    const zero = await mod.insertItems(db, { rows: [] });
    expect(zero).toBe(0);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
    await rm(dir, { recursive: true, force: true });
  }
});

dbTest("warns about overrides that will break at runtime, unless runtime is none", async () => {
  const dir = new URL("./__tmp__/warn/", import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(
    new URL("schema.sql", dir),
    "CREATE TABLE e (id int PRIMARY KEY, at timestamptz NOT NULL);",
  );
  await writeFile(
    new URL("q.sql", dir),
    "-- name: AtLeast :many\nSELECT id, at FROM e WHERE at >= @since;",
  );
  const base = fileURLToPath(dir);

  try {
    // Type-only override: `at` (result) and `since` (param) both lack converters.
    const bad = await generateFromConfig(
      {
        connection: connection!,
        schema: "schema.sql",
        queries: "q.sql",
        out: "out.ts",
        overrides: { timestamptz: "X" },
      },
      base,
    );
    expect(bad.warnings.length).toBe(2);
    const joined = bad.warnings.join("\n");
    expect(joined).toContain("timestamptz");
    expect(joined).toContain("parse");
    expect(joined).toContain("serialize");

    // Declaring runtime: "none" silences the advisories.
    const ok = await generateFromConfig(
      {
        connection: connection!,
        schema: "schema.sql",
        queries: "q.sql",
        out: "out.ts",
        overrides: { timestamptz: { type: "X", runtime: "none" } },
      },
      base,
    );
    expect(ok.warnings).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

dbTest("reports per-query errors without aborting the rest", async () => {
  const engine = await PgEngine.create(connection!);
  try {
    const progress: string[] = [];
    const { analyzed, errors } = await analyzeQueries({
      engine,
      queries: parseQueryFile(`
-- name: Good :many
SELECT id FROM users;

-- name: Bad :many
SELECT * FROM table_that_does_not_exist;
`),
      schema: SCHEMA,
      progress: (message) => progress.push(message),
    });

    expect(analyzed.map((a) => a.query.name)).toEqual(["Good"]);
    expect(errors.length).toBe(1);
    expect(errors[0].name).toBe("Bad");
    expect(progress).toContain("applying schema");
    expect(progress).toContain("describing query Good");
    expect(progress).toContain("describing query Bad");
    expect(progress.some((m) => m.startsWith("query Bad failed:"))).toBe(true);
    expect(progress).toContain("loading PostgreSQL type catalog");
  } finally {
    await engine.dispose();
  }
});

dbTest("does not write output when any query fails to analyze", async () => {
  const dir = new URL("./__tmp__/errors/", import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL("schema.sql", dir), SCHEMA);
  await writeFile(
    new URL("q.sql", dir),
    `
-- name: Good :many
SELECT id FROM users;

-- name: Bad :many
SELECT * FROM table_that_does_not_exist;
`,
  );
  await writeFile(new URL("out.ts", dir), "sentinel");

  try {
    const result = await generateFromConfig(
      {
        connection: connection!,
        schema: "schema.sql",
        queries: "q.sql",
        out: "out.ts",
      },
      fileURLToPath(dir),
    );

    expect(result.count).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.code).toBe("");
    expect(await readFile(new URL("out.ts", dir), "utf8")).toBe("sentinel");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
