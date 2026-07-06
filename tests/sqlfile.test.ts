import { expect, test } from "vite-plus/test";
import { parseQueryFile } from "../src/sqlfile.ts";

test("parses multiple annotated queries", () => {
  const src = `-- name: GetUser :one
SELECT id, email FROM users WHERE id = @id;

-- name: ListUsers :many
SELECT * FROM users ORDER BY id;
`;
  const queries = parseQueryFile(src);
  expect(queries.length).toBe(2);
  expect(queries[0]).toEqual({
    name: "GetUser",
    command: "one",
    nonNullColumns: [],
    sql: "SELECT id, email FROM users WHERE id = @id",
  });
  expect(queries[1].name).toBe("ListUsers");
  expect(queries[1].command).toBe("many");
});

test("parses leading line comments as docs", () => {
  const src = `-- name: X :exec
-- Delete a row.
-- @deprecated Use Archive instead.
DELETE FROM t WHERE id = @id;`;
  const queries = parseQueryFile(src);
  expect(queries[0].docs).toEqual(["Delete a row."]);
  expect(queries[0].deprecated).toBe("Use Archive instead.");
  expect(queries[0].sql).toBe("DELETE FROM t WHERE id = @id");
});

test("parses deprecated without prose docs", () => {
  const src = `-- name: OldGetUser :one
-- @deprecated Use GetUser instead.
SELECT id FROM users WHERE id = @id;`;
  const queries = parseQueryFile(src);
  expect(queries[0].docs).toBeUndefined();
  expect(queries[0].deprecated).toBe("Use GetUser instead.");
  expect(queries[0].sql).toBe("SELECT id FROM users WHERE id = @id");
});

test("parses leading block comments as docs", () => {
  const src = `-- name: X :one
/*
 * Fetch a row.
 *
 * Returns null when missing.
 * @deprecated Use GetRowV2.
 */
SELECT * FROM t WHERE id = @id;`;
  const queries = parseQueryFile(src);
  expect(queries[0].docs).toEqual(["Fetch a row.", "", "Returns null when missing."]);
  expect(queries[0].deprecated).toBe("Use GetRowV2.");
  expect(queries[0].sql).toBe("SELECT * FROM t WHERE id = @id");
});

test("keeps SQL comments after the body starts", () => {
  const src = `-- name: X :exec
DELETE FROM t
-- keep this SQL comment
WHERE id = @id;`;
  const queries = parseQueryFile(src);
  expect(queries[0].docs).toBeUndefined();
  expect(queries[0].sql).toBe("DELETE FROM t\n-- keep this SQL comment\nWHERE id = @id");
});

test("parses nonnull directives without keeping them in SQL", () => {
  const queries = parseQueryFile(`-- name: X :many
-- nonnull: id, workspace_id, "display name"
SELECT id, workspace_id, display_name FROM t;`);

  expect(queries[0].nonNullColumns).toEqual(["id", "workspace_id", "display name"]);
  expect(queries[0].sql).toBe("SELECT id, workspace_id, display_name FROM t");
});

test("rejects unknown commands", () => {
  expect(() => parseQueryFile("-- name: Bad :wat\nSELECT 1;")).toThrow(/unknown command/);
});

test("rejects SQL before a name annotation", () => {
  expect(() => parseQueryFile("SELECT 1;", "queries.sql")).toThrow(
    /queries\.sql:1: SQL query is missing/,
  );
  expect(() => parseQueryFile("/* comment */ SELECT 1;", "queries.sql")).toThrow(
    /queries\.sql:1: SQL query is missing/,
  );
  expect(() =>
    parseQueryFile(
      `/*
comment
*/ SELECT 1;`,
      "queries.sql",
    ),
  ).toThrow(/queries\.sql:3: SQL query is missing/);
});

test("rejects another SQL statement after a completed annotated query", () => {
  expect(() =>
    parseQueryFile(
      `-- name: A :one
SELECT 1;
SELECT 2;`,
      "queries.sql",
    ),
  ).toThrow(/queries\.sql:3: SQL query is missing/);
  expect(() =>
    parseQueryFile(
      `-- name: A :one
SELECT 1;
/* comment */ SELECT 2;`,
      "queries.sql",
    ),
  ).toThrow(/queries\.sql:3: SQL query is missing/);
});

test("allows file-level comments before the first query", () => {
  const queries = parseQueryFile(`/*
 * Shared user queries.
 */
-- generated manually

-- name: A :one
SELECT 1;`);
  expect(queries[0].name).toBe("A");
  expect(queries[0].sql).toBe("SELECT 1");
});

test("allows comments between annotated queries", () => {
  const queries = parseQueryFile(`-- name: A :one
SELECT 1;

/*
 * Group B.
 */
-- name: B :one
SELECT 2;`);
  expect(queries.map((q) => q.name)).toEqual(["A", "B"]);
});

test("ignores trailing whitespace and semicolons", () => {
  const queries = parseQueryFile("-- name: A :one\nSELECT 1 ;\n\n");
  expect(queries[0].sql).toBe("SELECT 1");
});
