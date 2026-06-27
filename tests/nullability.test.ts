import { expect, test } from "vite-plus/test";
import {
  fromAliases,
  inferNonNullOutputColumns,
  selectExpressions,
  simpleColumnRef,
} from "../src/nullability.ts";

test("infers COALESCE with a non-null literal output as not null", () => {
  const inferred = inferNonNullOutputColumns(`
    SELECT
      id,
      COALESCE(planned_cents, 0) AS planned_cents,
      COALESCE(note, NULL) AS note
    FROM workspace_bucket_plans
  `);

  expect([...inferred]).toEqual([1]);
});

test("handles quoted strings, casts, aliases, and view definitions", () => {
  const inferred = inferNonNullOutputColumns(`
    SELECT
      COALESCE(name, 'unknown'::text) name,
      COALESCE(description, NULL::text) AS description,
      (COALESCE(active, false)) AS active
    FROM users
  `);

  expect([...inferred]).toEqual([0, 2]);
});

test("ignores commas inside nested calls and strings", () => {
  const inferred = inferNonNullOutputColumns(`
    SELECT
      COALESCE(format('%s, %s', first_name, last_name), 'n/a') AS display_name,
      COALESCE(optional_value, maybe_null_value) AS maybe_value
    FROM users
  `);

  expect([...inferred]).toEqual([0]);
});

test("extracts simple select column references", () => {
  const expressions = selectExpressions(`
    SELECT
      w.id AS workspace_id,
      bt.code bucket_type,
      COALESCE(wb.planned_cents, 0) AS planned_cents
    FROM workspaces w
  `);

  expect(expressions).toEqual(["w.id", "bt.code", "COALESCE(wb.planned_cents, 0)"]);
  expect(simpleColumnRef(expressions[0]!)).toEqual({ table: "w", column: "id" });
  expect(simpleColumnRef(expressions[2]!)).toBeNull();
});

test("marks aliases from outer-join nullable sides", () => {
  expect(
    fromAliases(`
      SELECT w.id, bt.code, wb.planned_cents
      FROM workspaces w
      CROSS JOIN bucket_types bt
      LEFT JOIN workspace_buckets wb ON wb.workspace_id = w.id
    `),
  ).toEqual([
    { alias: "w", relation: "workspaces", nullable: false },
    { alias: "bt", relation: "bucket_types", nullable: false },
    { alias: "wb", relation: "workspace_buckets", nullable: true },
  ]);
});
