import { expect, test } from "vite-plus/test";
import { generateModule } from "../src/codegen.ts";
import { emptyTypeInfo } from "../src/typemap.ts";
import { attrKey } from "../src/typemap.ts";
import type { AnalyzedQuery } from "../src/model.ts";
import type { QueryParam, RewrittenQuery } from "../src/params.ts";

function scalarParam(name: string, placeholder: number, nullable = false): QueryParam {
  return { name, kind: "scalar", nullable, placeholders: [placeholder] };
}

/** A static (scalar-only) RewrittenQuery; codegen reads introspectText + params. */
function staticRewritten(introspectText: string, params: QueryParam[]): RewrittenQuery {
  return { segments: [introspectText], params, introspectText, dynamic: false };
}

function ctx() {
  const notNull = new Map<string, boolean>();
  notNull.set(attrKey(100, 1), true); // id is NOT NULL
  notNull.set(attrKey(100, 2), false); // nickname is nullable
  return { typeInfo: emptyTypeInfo(), notNull };
}

test("generates a :one function with args and a row interface", () => {
  const analyzed: AnalyzedQuery[] = [
    {
      query: {
        name: "GetUser",
        command: "one",
        sql: "SELECT id, nickname FROM users WHERE id = @id",
      },
      rewritten: staticRewritten("SELECT id, nickname FROM users WHERE id = $1", [
        scalarParam("id", 1),
      ]),
      shape: {
        params: [23],
        columns: [
          { name: "id", tableOid: 100, columnAttr: 1, typeOid: 23 },
          { name: "nickname", tableOid: 100, columnAttr: 2, typeOid: 25 },
        ],
      },
    },
  ];

  const code = generateModule(analyzed, ctx());
  expect(code).toContain("export interface GetUserArgs {\n  id: number;\n}");
  expect(code).toContain("export interface GetUserRow {");
  expect(code).toContain("id: number;"); // NOT NULL -> no | null
  expect(code).toContain("nickname: string | null;"); // nullable
  expect(code).toContain(
    "export async function getUser(db: Queryable, args: GetUserArgs): Promise<GetUserRow | null>",
  );
  expect(code).toContain("await db.query(getUserSql, [args.id])");
  expect(code).toContain("export function bind(db: Queryable)");
  expect(code).toContain("getUser: (args: GetUserArgs) => getUser(db, args)");
  expect(code).toContain("interface Queryable"); // inlined runtime
});

test("applies type overrides and emits import lines", () => {
  const typeInfo = emptyTypeInfo();
  typeInfo.types.set(1184, {
    oid: 1184,
    name: "timestamptz",
    typtype: "b",
    typcategory: "D",
    typelem: 0,
    typbasetype: 0,
  });
  const notNull = new Map<string, boolean>();
  notNull.set(attrKey(100, 1), true);

  const analyzed: AnalyzedQuery[] = [
    {
      query: { name: "GetCreated", command: "one", sql: "SELECT created FROM t WHERE id = @id" },
      rewritten: staticRewritten("SELECT created FROM t WHERE id = $1", [scalarParam("id", 1)]),
      shape: {
        params: [23],
        columns: [{ name: "created", tableOid: 100, columnAttr: 1, typeOid: 1184 }],
      },
    },
  ];

  const code = generateModule(analyzed, {
    typeInfo,
    notNull,
    overrides: new Map([["timestamptz", "Temporal.Instant"]]),
    imports: ["import { Temporal } from 'temporal-polyfill';"],
  });

  expect(code).toContain("import { Temporal } from 'temporal-polyfill';");
  expect(code).toContain("created: Temporal.Instant;");
  expect(code).toContain("id: number;"); // non-overridden param unaffected
});

test("serializes scalar array params element-wise for ANY-style queries", () => {
  const typeInfo = emptyTypeInfo();
  typeInfo.types.set(1184, {
    oid: 1184,
    name: "timestamptz",
    typtype: "b",
    typcategory: "D",
    typelem: 0,
    typbasetype: 0,
  });
  typeInfo.types.set(1185, {
    oid: 1185,
    name: "_timestamptz",
    typtype: "b",
    typcategory: "A",
    typelem: 1184,
    typbasetype: 0,
  });

  const analyzed: AnalyzedQuery[] = [
    {
      query: {
        name: "SinceAny",
        command: "many",
        sql: "SELECT id FROM events WHERE created = ANY(@since)",
      },
      rewritten: staticRewritten("SELECT id FROM events WHERE created = ANY($1)", [
        scalarParam("since", 1),
      ]),
      shape: {
        params: [1185],
        columns: [{ name: "id", tableOid: 100, columnAttr: 1, typeOid: 23 }],
      },
    },
  ];

  const code = generateModule(analyzed, {
    typeInfo,
    notNull: new Map([[attrKey(100, 1), true]]),
    overrides: new Map([["timestamptz", "Temporal.Instant"]]),
    serializers: new Map([["timestamptz", "(value) => value.toString()"]]),
  });

  expect(code).toContain("since: Temporal.Instant[];");
  expect(code).toContain("const __ser_timestamptz = (value) => value.toString();");
  expect(code).toContain(
    "args.since == null ? null : args.since.map((e) => (e == null ? null : __ser_timestamptz(e)))",
  );
});

test("uses inferred expression nullability for result columns", () => {
  const analyzed: AnalyzedQuery[] = [
    {
      query: {
        name: "Plan",
        command: "one",
        sql: "SELECT COALESCE(planned_cents, 0) AS planned_cents",
      },
      rewritten: staticRewritten("SELECT COALESCE(planned_cents, 0) AS planned_cents", []),
      shape: {
        params: [],
        columns: [{ name: "planned_cents", tableOid: 0, columnAttr: 0, typeOid: 20 }],
      },
      inferredNotNullColumns: new Set([0]),
    },
  ];

  const code = generateModule(analyzed, ctx());
  expect(code).toContain("planned_cents: string;");
  expect(code).not.toContain("planned_cents: string | null;");
});

test("camel caseStyle maps params, result rows, and runtime row keys", () => {
  const analyzed: AnalyzedQuery[] = [
    {
      query: {
        name: "GetWorkspace",
        command: "one",
        sql: "SELECT workspace_id, full_name FROM users WHERE full_name = @full_name",
      },
      rewritten: staticRewritten("SELECT workspace_id, full_name FROM users WHERE full_name = $1", [
        scalarParam("full_name", 1),
      ]),
      shape: {
        params: [25],
        columns: [
          { name: "workspace_id", tableOid: 100, columnAttr: 1, typeOid: 20 },
          { name: "full_name", tableOid: 100, columnAttr: 2, typeOid: 25 },
        ],
      },
    },
  ];

  const code = generateModule(analyzed, { ...ctx(), caseStyle: "camel" });
  expect(code).toContain("export interface GetWorkspaceArgs {\n  fullName: string;\n}");
  expect(code).toContain("workspaceId: string;");
  expect(code).toContain("fullName: string | null;");
  expect(code).toContain("await db.query(getWorkspaceSql, [args.fullName])");
  expect(code).toContain("workspaceId: r.workspace_id,");
  expect(code).toContain("fullName: r.full_name,");
  expect(code).toContain("return row ? hydrateGetWorkspaceRow(row) : null;");
});

test("generates :exec and :execrows without a row interface", () => {
  const analyzed: AnalyzedQuery[] = [
    {
      query: { name: "DeleteUser", command: "exec", sql: "DELETE FROM users WHERE id = @id" },
      rewritten: staticRewritten("DELETE FROM users WHERE id = $1", [scalarParam("id", 1)]),
      shape: { params: [23], columns: [] },
    },
    {
      query: { name: "Touch", command: "execrows", sql: "UPDATE users SET seen = now()" },
      rewritten: staticRewritten("UPDATE users SET seen = now()", []),
      shape: { params: [], columns: [] },
    },
  ];

  const code = generateModule(analyzed, ctx());
  expect(code).toContain(
    "export async function deleteUser(db: Queryable, args: DeleteUserArgs): Promise<void>",
  );
  expect(code).not.toContain("DeleteUserRow");
  expect(code).toContain("export async function touch(db: Queryable): Promise<number>");
  expect(code).toContain("deleteUser: (args: DeleteUserArgs) => deleteUser(db, args)");
  expect(code).toContain("touch: () => touch(db)");
  expect(code).toContain("return result.rowCount ?? 0;");
});

test("rejects invalid or colliding generated query identifiers", () => {
  const validShape = {
    params: [],
    columns: [{ name: "id", tableOid: 100, columnAttr: 1, typeOid: 23 }],
  };
  const first: AnalyzedQuery = {
    query: { name: "ListUsers", command: "many", sql: "SELECT id FROM users" },
    rewritten: staticRewritten("SELECT id FROM users", []),
    shape: validShape,
  };
  const second: AnalyzedQuery = {
    query: { name: "list_users", command: "many", sql: "SELECT id FROM users" },
    rewritten: staticRewritten("SELECT id FROM users", []),
    shape: validShape,
  };
  const invalid: AnalyzedQuery = {
    query: { name: "123", command: "many", sql: "SELECT id FROM users" },
    rewritten: staticRewritten("SELECT id FROM users", []),
    shape: validShape,
  };

  expect(() => generateModule([first, second], ctx())).toThrow(/collides/);
  expect(() => generateModule([invalid], ctx())).toThrow(/valid TypeScript identifier/);
});
