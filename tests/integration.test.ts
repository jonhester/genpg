import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PgliteEngine } from "../src/engine.ts";
import { analyzeQueries } from "../src/introspect.ts";
import { parseQueryFile } from "../src/sqlfile.ts";
import { generateModule } from "../src/codegen.ts";
import { generateFromConfig } from "../src/index.ts";

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

test("end-to-end introspection + codegen against in-process pglite", async () => {
  const engine = await PgliteEngine.create();
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

test("type overrides apply by real Postgres type name (Temporal)", async () => {
  const engine = await PgliteEngine.create();
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

test("hydrates result rows and serializes params for runtime conversion", async () => {
  const engine = await PgliteEngine.create();
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

test("generated hydration + serialization round-trips through pglite", async () => {
  // Override `text` so values are upper-cased on read and lower-cased on write.
  const schema = `CREATE TABLE t (id int PRIMARY KEY, name text NOT NULL);`;
  const queries = `
-- name: Insert :one
INSERT INTO t (id, name) VALUES (@id, @name) RETURNING id, name;

-- name: Get :one
SELECT id, name FROM t WHERE id = @id;
`;

  const engine = await PgliteEngine.create();
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
    });
  } finally {
    await engine.dispose();
  }

  const dir = new URL("./__tmp__/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL(`hyd_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`, dir);
  await writeFile(file, code);

  const pg = await PGlite.create();
  await pg.exec(schema);
  const db = {
    async query(text: string, values: unknown[]) {
      const r = await pg.query(text, values as any[]);
      return { rows: r.rows as any[], rowCount: (r as any).affectedRows ?? r.rows.length };
    },
  };

  try {
    const mod: any = await import(file.href);
    // "Hello" -> serialized to "hello" on insert -> hydrated to "HELLO" on return.
    const inserted = await mod.insert(db, { id: 1, name: "Hello" });
    expect(inserted.name).toBe("HELLO");
    // Stored value is the lower-cased "hello"; read hydrates it back to "HELLO".
    const got = await mod.get(db, { id: 1 });
    expect(got.name).toBe("HELLO");
  } finally {
    await pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated array + spread queries actually execute against pglite", async () => {
  const schema = `CREATE TABLE items (id int PRIMARY KEY, name text NOT NULL);`;
  const queries = `
-- name: InsertItems :execrows
INSERT INTO items (id, name) VALUES @rows(spread);

-- name: ByIds :many
SELECT id, name FROM items WHERE id IN @ids(array) ORDER BY id;
`;

  const engine = await PgliteEngine.create();
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

  // A fresh DB with the same schema, wrapped as a Queryable.
  const pg = await PGlite.create();
  await pg.exec(schema);
  const db = {
    async query(text: string, values: unknown[]) {
      const r = await pg.query(text, values as any[]);
      return { rows: r.rows as any[], rowCount: (r as any).affectedRows ?? r.rows.length };
    },
  };

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
    await pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("warns about overrides that will break at runtime, unless runtime is none", async () => {
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
      { schema: "schema.sql", queries: "q.sql", out: "out.ts", overrides: { timestamptz: "X" } },
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

test("reports per-query errors without aborting the rest", async () => {
  const engine = await PgliteEngine.create();
  try {
    const { analyzed, errors } = await analyzeQueries({
      engine,
      queries: parseQueryFile(`
-- name: Good :many
SELECT id FROM users;

-- name: Bad :many
SELECT * FROM table_that_does_not_exist;
`),
      schema: SCHEMA,
    });

    expect(analyzed.map((a) => a.query.name)).toEqual(["Good"]);
    expect(errors.length).toBe(1);
    expect(errors[0].name).toBe("Bad");
  } finally {
    await engine.dispose();
  }
});
