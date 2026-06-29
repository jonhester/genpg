import { expect, test } from "vite-plus/test";
import {
  fromAliases,
  columnRefsInExpression,
  inferCoalesceFallbackOutputColumns,
  inferNonNullExpression,
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

test("infers query-level COALESCE aggregate fallback as not null", () => {
  const inferred = inferCoalesceFallbackOutputColumns(`
    SELECT
      COALESCE(SUM(e.normalized_monthly_take_home_cents), 0)::bigint AS total_income_cents,
      SUM(e.normalized_monthly_take_home_cents)::bigint AS maybe_total
    FROM income_source_expectations e
  `);

  expect([...inferred]).toEqual([0]);
});

test("infers standalone generated-column expressions", () => {
  expect(inferNonNullExpression("COALESCE(monthly_cents, 0)::bigint")).toBe(true);
  expect(inferNonNullExpression("(COALESCE(monthly_cents, 0))")).toBe(true);
  expect(
    inferNonNullExpression("u.first_name || ' ' || u.last_name", {
      isNonNullColumn: (ref) => ref.table === "u",
    }),
  ).toBe(true);
  expect(
    inferNonNullExpression("date_trunc('month', u.created_at)", {
      isNonNullColumn: (ref) => ref.table === "u" && ref.column === "created_at",
    }),
  ).toBe(true);
  expect(
    inferNonNullExpression("u.first_name || ' ' || u.nickname", {
      isNonNullColumn: (ref) => ref.column !== "nickname",
    }),
  ).toBe(false);
  expect(inferNonNullExpression("monthly_cents + 1")).toBe(false);
  expect(inferNonNullExpression("NULL::bigint")).toBe(false);
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

test("extracts column refs from expressions without reading string literals", () => {
  expect(columnRefsInExpression("u.first_name || 'x.y' || u.last_name")).toEqual([
    { table: "u", column: "first_name" },
    { table: "u", column: "last_name" },
  ]);
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

test("extracts primary FROM alias through pg_get_viewdef join parentheses", () => {
  expect(
    fromAliases(`
      SELECT w.id, bt.code, wb.planned_cents
      FROM (workspaces w
        CROSS JOIN bucket_types bt)
        LEFT JOIN workspace_buckets wb ON wb.workspace_id = w.id
    `),
  ).toEqual([
    { alias: "w", relation: "workspaces", nullable: false },
    { alias: "bt", relation: "bucket_types", nullable: false },
    { alias: "wb", relation: "workspace_buckets", nullable: true },
  ]);
});

test("does not treat a following join keyword as an alias", () => {
  expect(
    fromAliases(`
      SELECT users.id, profiles.bio
      FROM users
      LEFT JOIN profiles ON profiles.user_id = users.id
    `),
  ).toEqual([
    { alias: "users", relation: "users", nullable: false },
    { alias: "profiles", relation: "profiles", nullable: true },
  ]);
});
