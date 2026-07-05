import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { PgEngine } from "../src/engine.ts";
import { analyzeQueries } from "../src/introspect.ts";
import { parseQueryFile } from "../src/sqlfile.ts";
import { generateModule } from "../src/codegen.ts";
import { fromPostgresJs, withPostgresJsTransaction, type Queryable } from "../src/runtime.ts";

const connection = process.env.TEST_DATABASE_URL;
const dbTest = test.skipIf(!connection);

const table = `genpg_drivers_${process.pid}`;

const schema = `CREATE TABLE ${table} (
  id       int PRIMARY KEY,
  email    text NOT NULL,
  nickname text
);`;

const queries = `
-- name: InsertPeople :execrows
INSERT INTO ${table} (id, email, nickname) VALUES @rows(spread);

-- name: GetPerson :one
SELECT id, email, nickname FROM ${table} WHERE id = @id;

-- name: ByIds :many
SELECT id, email FROM ${table} WHERE id IN @ids(array) ORDER BY id;

-- name: DeletePerson :exec
DELETE FROM ${table} WHERE id = @id;
`;

/**
 * The generated functions only know the structural `Queryable` interface, so the
 * exact same calls must behave identically whether `db` is a node-postgres client
 * (a `Queryable` directly) or postgres.js wrapped by `fromPostgresJs`. We run one
 * shared suite against both real drivers, end to end against PostgreSQL.
 */
dbTest("generated queries run identically through pg and postgres.js", async () => {
  // 1. Introspect + generate the module from the real database.
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

  // 2. Write the generated module and import it for real execution.
  const dir = new URL("./__tmp__/drivers/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL(`mod_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`, dir);
  await writeFile(file, code);
  const mod: any = await import(file.href);

  // 3. Create the real table (committed) so both driver connections can see it.
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`DROP TABLE IF EXISTS ${table}`);
  await admin.query(schema);

  // The same assertions, run against any Queryable.
  async function exercise(db: Queryable): Promise<void> {
    await db.query(`TRUNCATE ${table}`, []);

    // Bulk insert via spread (:execrows -> affected count).
    const inserted = await mod.insertPeople(db, {
      rows: [
        { id: 1, email: "a@example.com", nickname: null },
        { id: 2, email: "b@example.com", nickname: "bee" },
        { id: 3, email: "c@example.com", nickname: null },
      ],
    });
    expect(inserted).toBe(3);

    // :one with a scalar param, including nullable + non-null columns.
    expect(await mod.getPerson(db, { id: 1 })).toEqual({
      id: 1,
      email: "a@example.com",
      nickname: null,
    });
    expect(await mod.getPerson(db, { id: 2 })).toEqual({
      id: 2,
      email: "b@example.com",
      nickname: "bee",
    });

    // :many with an array param expanded to an IN list.
    const some = await mod.byIds(db, { ids: [1, 3] });
    expect(some.map((r: any) => r.id)).toEqual([1, 3]);

    // Empty array -> IN (NULL) matches nothing, no SQL error.
    expect(await mod.byIds(db, { ids: [] })).toEqual([]);

    // Empty spread short-circuits without hitting the database.
    expect(await mod.insertPeople(db, { rows: [] })).toBe(0);

    // :exec returns void; the row is really gone afterward.
    await mod.deletePerson(db, { id: 2 });
    expect(await mod.getPerson(db, { id: 2 })).toBeNull();
  }

  const pgClient = new Client({ connectionString: connection });
  await pgClient.connect();
  const sql = postgres(connection!, { max: 1 });

  try {
    // node-postgres: a Client is a Queryable directly.
    await exercise(pgClient);
    // postgres.js: via the runtime adapter.
    await exercise(fromPostgresJs(sql));
  } finally {
    await pgClient.end();
    await sql.end({ timeout: 5 });
    await admin.query(`DROP TABLE IF EXISTS ${table}`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});

dbTest("runtime converters round-trip through postgres.js", async () => {
  const convertTable = `genpg_pgjs_converters_${process.pid}`;
  const convertSchema = `CREATE TABLE ${convertTable} (
    id        int PRIMARY KEY,
    full_name text NOT NULL
  );`;
  const convertQueries = `
-- name: Insert :one
INSERT INTO ${convertTable} (id, full_name) VALUES (@id, @full_name) RETURNING id, full_name;

-- name: Get :one
SELECT id, full_name FROM ${convertTable} WHERE id = @id;
`;

  const engine = await PgEngine.create(connection!);
  let code: string;
  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      queries: parseQueryFile(convertQueries),
      schema: convertSchema,
    });
    expect(errors).toEqual([]);
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

  const dir = new URL("./__tmp__/drivers/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL(`convert_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`, dir);
  await writeFile(file, code);
  const mod: any = await import(file.href);

  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`DROP TABLE IF EXISTS ${convertTable}`);
  await admin.query(convertSchema);
  const sql = postgres(connection!, { max: 1 });

  try {
    const db = fromPostgresJs(sql);
    const inserted = await mod.insert(db, { id: 1, fullName: "Hello" });
    expect(inserted.fullName).toBe("HELLO");
    expect(inserted.full_name).toBeUndefined();

    const stored = await admin.query(`SELECT full_name FROM ${convertTable} WHERE id = $1`, [1]);
    expect(stored.rows[0]?.full_name).toBe("hello");

    const got = await mod.get(db, { id: 1 });
    expect(got.fullName).toBe("HELLO");
    expect(got.full_name).toBeUndefined();
  } finally {
    await sql.end({ timeout: 5 });
    await admin.query(`DROP TABLE IF EXISTS ${convertTable}`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});

dbTest("withPostgresJsTransaction commits and rolls back against real postgres.js", async () => {
  const txTable = `genpg_pgjs_tx_${process.pid}`;
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`DROP TABLE IF EXISTS ${txTable}`);
  await admin.query(`CREATE TABLE ${txTable} (id int PRIMARY KEY, label text NOT NULL)`);

  const sql = postgres(connection!, { max: 1 });

  try {
    await withPostgresJsTransaction(sql, async (tx) => {
      await tx.query(`INSERT INTO ${txTable} (id, label) VALUES ($1, $2)`, [1, "committed"]);
    });

    let rows = await admin.query(`SELECT id, label FROM ${txTable} ORDER BY id`);
    expect(rows.rows).toEqual([{ id: 1, label: "committed" }]);

    await expect(
      withPostgresJsTransaction(sql, async (tx) => {
        await tx.query(`INSERT INTO ${txTable} (id, label) VALUES ($1, $2)`, [2, "rolled back"]);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    rows = await admin.query(`SELECT id, label FROM ${txTable} ORDER BY id`);
    expect(rows.rows).toEqual([{ id: 1, label: "committed" }]);
  } finally {
    await sql.end({ timeout: 5 });
    await admin.query(`DROP TABLE IF EXISTS ${txTable}`);
    await admin.end();
  }
});
