import { expect, test } from "vite-plus/test";
import { tsForOid, typeNamesForOid, emptyTypeInfo, type TypeInfo } from "../src/typemap.ts";

test("maps common builtin scalars", () => {
  const info = emptyTypeInfo();
  expect(tsForOid(16, info)).toBe("boolean"); // bool
  expect(tsForOid(23, info)).toBe("number"); // int4
  expect(tsForOid(20, info)).toBe("string"); // int8 -> string
  expect(tsForOid(25, info)).toBe("string"); // text
  expect(tsForOid(1184, info)).toBe("Date"); // timestamptz
  expect(tsForOid(1700, info)).toBe("string"); // numeric -> string
  expect(tsForOid(3802, info)).toBe("unknown"); // jsonb
  expect(tsForOid(0, info)).toBe("unknown"); // unknown param
});

test("resolves arrays via typelem", () => {
  const info: TypeInfo = emptyTypeInfo();
  info.types.set(1007, {
    oid: 1007,
    name: "_int4",
    typtype: "b",
    typcategory: "A",
    typelem: 23,
    typbasetype: 0,
  });
  expect(tsForOid(1007, info)).toBe("number[]");
});

test("resolves enums to a string-literal union", () => {
  const info: TypeInfo = emptyTypeInfo();
  info.types.set(50000, {
    oid: 50000,
    name: "mood",
    typtype: "e",
    typcategory: "E",
    typelem: 0,
    typbasetype: 0,
  });
  info.enums.set(50000, ["sad", "ok", "happy"]);
  expect(tsForOid(50000, info)).toBe('"sad" | "ok" | "happy"');
});

test("resolves domains to their base type", () => {
  const info: TypeInfo = emptyTypeInfo();
  info.types.set(50001, {
    oid: 50001,
    name: "email",
    typtype: "d",
    typcategory: "S",
    typelem: 0,
    typbasetype: 25,
  });
  expect(tsForOid(50001, info)).toBe("string");
});

test("lists type names through arrays and domains in override precedence order", () => {
  const info: TypeInfo = emptyTypeInfo();
  info.types.set(1184, {
    oid: 1184,
    name: "timestamptz",
    typtype: "b",
    typcategory: "D",
    typelem: 0,
    typbasetype: 0,
  });
  info.types.set(50001, {
    oid: 50001,
    name: "created_at",
    typtype: "d",
    typcategory: "D",
    typelem: 0,
    typbasetype: 1184,
  });
  info.types.set(50002, {
    oid: 50002,
    name: "_created_at",
    typtype: "b",
    typcategory: "A",
    typelem: 50001,
    typbasetype: 0,
  });

  expect(typeNamesForOid(50001, info)).toEqual(["created_at", "timestamptz"]);
  expect(typeNamesForOid(50002, info)).toEqual(["_created_at", "created_at", "timestamptz"]);
});

test("name overrides win and apply recursively through arrays", () => {
  const info: TypeInfo = emptyTypeInfo();
  // timestamptz scalar + its array (_timestamptz) in the catalog snapshot.
  info.types.set(1184, {
    oid: 1184,
    name: "timestamptz",
    typtype: "b",
    typcategory: "D",
    typelem: 0,
    typbasetype: 0,
  });
  info.types.set(1185, {
    oid: 1185,
    name: "_timestamptz",
    typtype: "b",
    typcategory: "A",
    typelem: 1184,
    typbasetype: 0,
  });
  const overrides = new Map([["timestamptz", "Temporal.Instant"]]);
  expect(tsForOid(1184, info, overrides)).toBe("Temporal.Instant");
  expect(tsForOid(1185, info, overrides)).toBe("Temporal.Instant[]");
});

test("wraps union element types in parentheses for arrays", () => {
  const info: TypeInfo = emptyTypeInfo();
  info.types.set(60000, {
    oid: 60000,
    name: "mood",
    typtype: "e",
    typcategory: "E",
    typelem: 0,
    typbasetype: 0,
  });
  info.enums.set(60000, ["a", "b"]);
  info.types.set(60001, {
    oid: 60001,
    name: "_mood",
    typtype: "b",
    typcategory: "A",
    typelem: 60000,
    typbasetype: 0,
  });
  expect(tsForOid(60001, info)).toBe('("a" | "b")[]');
});
