import { expect, test } from "vite-plus/test";
import { rewriteNamedParams } from "../src/params.ts";

const names = (sql: string) => rewriteNamedParams(sql).params.map((p) => p.name);

test("rewrites named params to positional", () => {
  const r = rewriteNamedParams("SELECT * FROM users WHERE id = @id AND status = @status");
  expect(r.introspectText).toBe("SELECT * FROM users WHERE id = $1 AND status = $2");
  expect(names("SELECT * FROM users WHERE id = @id AND status = @status")).toEqual([
    "id",
    "status",
  ]);
  expect(r.dynamic).toBe(false);
});

test("repeated names reuse the same position", () => {
  const r = rewriteNamedParams("SELECT @id WHERE a = @id OR b = @other");
  expect(r.introspectText).toBe("SELECT $1 WHERE a = $1 OR b = $2");
  expect(r.params.map((p) => p.name)).toEqual(["id", "other"]);
});

test("repeated names must use consistent markers", () => {
  expect(() => rewriteNamedParams("SELECT @id WHERE a = @id?")).toThrow(/inconsistent/);
  expect(() => rewriteNamedParams("SELECT @ids(array), @ids")).toThrow(/inconsistent/);
});

test("does not touch @ inside string literals or comments", () => {
  const r = rewriteNamedParams("-- @nope\nSELECT '@x' AS a, @real /* @also */");
  expect(r.introspectText).toBe("-- @nope\nSELECT '@x' AS a, $1 /* @also */");
  expect(r.params.map((p) => p.name)).toEqual(["real"]);
});

test("leaves jsonb containment operator alone", () => {
  const r = rewriteNamedParams("SELECT * FROM t WHERE data @> @filter");
  expect(r.introspectText).toBe("SELECT * FROM t WHERE data @> $1");
});

test("ignores params in dollar-quoted strings", () => {
  const r = rewriteNamedParams("SELECT $tag$ @nope $tag$, @yes");
  expect(r.introspectText).toBe("SELECT $tag$ @nope $tag$, $1");
  expect(r.params.map((p) => p.name)).toEqual(["yes"]);
});

test("nullability markers: default non-null, ? nullable, ! explicit non-null", () => {
  const r = rewriteNamedParams("SELECT * FROM t WHERE a = @a AND b = @b? AND c = @c!");
  expect(r.introspectText).toBe("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3");
  expect(r.params.map((p) => ({ name: p.name, nullable: p.nullable }))).toEqual([
    { name: "a", nullable: false },
    { name: "b", nullable: true },
    { name: "c", nullable: false },
  ]);
});

test("array params introspect as a single-element tuple", () => {
  const r = rewriteNamedParams("SELECT * FROM t WHERE id IN @ids(array)");
  expect(r.introspectText).toBe("SELECT * FROM t WHERE id IN ($1)");
  expect(r.dynamic).toBe(true);
  expect(r.params[0].kind).toBe("array");
});

test("spread params introspect as one tuple and capture column names", () => {
  const r = rewriteNamedParams("INSERT INTO users (email, name) VALUES @rows(spread)");
  expect(r.introspectText).toBe("INSERT INTO users (email, name) VALUES ($1, $2)");
  expect(r.dynamic).toBe(true);
  expect(r.params[0].kind).toBe("spread");
  expect(r.params[0].fields).toEqual(["email", "name"]);
});

test("spread param outside an INSERT is rejected", () => {
  expect(() => rewriteNamedParams("SELECT @rows(spread)")).toThrow(/spread/);
});
