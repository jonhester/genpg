import { expect, test } from "vite-plus/test";
import {
  fromPg,
  fromPostgresJs,
  withPostgresJsTransaction,
  withTransaction,
  type PostgresJsSql,
  type Queryable,
} from "../src/runtime.ts";

test("fromPg returns the client unchanged", () => {
  const client = { query: async () => ({ rows: [], rowCount: 0 }) } satisfies Queryable;
  expect(fromPg(client)).toBe(client);
});

test("fromPostgresJs passes text/values to unsafe and normalizes the result", async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  // postgres.js returns an array-like result carrying a `count` property.
  const result = Object.assign([{ id: 1 }, { id: 2 }], { count: 2 });
  const sql: PostgresJsSql = {
    unsafe(text, values) {
      calls.push({ text, values: values ?? [] });
      return Promise.resolve(result);
    },
  };

  const db = fromPostgresJs(sql);
  const out = await db.query("SELECT id FROM t WHERE x = $1", [42]);

  expect(calls).toEqual([{ text: "SELECT id FROM t WHERE x = $1", values: [42] }]);
  // postgres.js returns the row array directly (it may carry its own `count`
  // property), so compare the elements rather than the array object.
  expect([...out.rows]).toEqual([{ id: 1 }, { id: 2 }]);
  expect(out.rowCount).toBe(2);
});

test("fromPostgresJs falls back to rows.length when count is absent", async () => {
  const sql: PostgresJsSql = {
    unsafe: () => Promise.resolve([{ id: 1 }, { id: 2 }, { id: 3 }]),
  };
  const out = await fromPostgresJs(sql).query("SELECT 1", []);
  expect(out.rowCount).toBe(3);
});

test("fromPostgresJs tolerates a non-array, nullish result", async () => {
  const sql: PostgresJsSql = { unsafe: () => Promise.resolve(undefined) };
  const out = await fromPostgresJs(sql).query("UPDATE t SET x = 1", []);
  expect(out.rows).toEqual([]);
  expect(out.rowCount).toBe(0);
});

test("withPostgresJsTransaction delegates to begin and wraps tx as Queryable", async () => {
  const seen: string[] = [];
  const txSql: PostgresJsSql = {
    unsafe(text) {
      seen.push(text);
      return Promise.resolve(Object.assign([], { count: 0 }));
    },
  };
  const sql: PostgresJsSql = {
    unsafe: () => Promise.reject(new Error("outer sql should not run queries")),
    begin: async (fn) => fn(txSql),
  };

  const result = await withPostgresJsTransaction(sql, async (tx) => {
    await tx.query("INSERT INTO t DEFAULT VALUES", []);
    return "ok";
  });

  expect(result).toBe("ok");
  expect(seen).toEqual(["INSERT INTO t DEFAULT VALUES"]);
});

test("withPostgresJsTransaction throws when begin is unsupported", async () => {
  const sql: PostgresJsSql = { unsafe: () => Promise.resolve([]) };
  await expect(withPostgresJsTransaction(sql, async () => 1)).rejects.toThrow(/begin/);
});

test("withTransaction commits and releases on success", async () => {
  const log: string[] = [];
  const client = {
    query: async (text: string) => {
      log.push(text);
      return { rows: [], rowCount: 0 };
    },
    release: () => log.push("RELEASE"),
  };
  const pool = { connect: async () => client };

  const out = await withTransaction(pool, async (tx) => {
    await tx.query("INSERT INTO t DEFAULT VALUES", []);
    return 7;
  });

  expect(out).toBe(7);
  expect(log).toEqual(["BEGIN", "INSERT INTO t DEFAULT VALUES", "COMMIT", "RELEASE"]);
});

test("withTransaction rolls back and releases on error", async () => {
  const log: string[] = [];
  const client = {
    query: async (text: string) => {
      log.push(text);
      return { rows: [], rowCount: 0 };
    },
    release: () => log.push("RELEASE"),
  };
  const pool = { connect: async () => client };

  await expect(
    withTransaction(pool, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");

  expect(log).toEqual(["BEGIN", "ROLLBACK", "RELEASE"]);
});
