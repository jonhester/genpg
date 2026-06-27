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
    sql: "SELECT id, email FROM users WHERE id = @id",
  });
  expect(queries[1].name).toBe("ListUsers");
  expect(queries[1].command).toBe("many");
});

test("keeps inner SQL comments in the body", () => {
  const src = `-- name: X :exec
-- a note
DELETE FROM t WHERE id = @id;`;
  const queries = parseQueryFile(src);
  expect(queries[0].sql).toBe("-- a note\nDELETE FROM t WHERE id = @id");
});

test("rejects unknown commands", () => {
  expect(() => parseQueryFile("-- name: Bad :wat\nSELECT 1;")).toThrow(/unknown command/);
});

test("ignores trailing whitespace and semicolons", () => {
  const queries = parseQueryFile("-- name: A :one\nSELECT 1 ;\n\n");
  expect(queries[0].sql).toBe("SELECT 1");
});
