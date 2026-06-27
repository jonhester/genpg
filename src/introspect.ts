/**
 * Orchestrates introspection over an {@link IntrospectionEngine}: applies the
 * schema, describes every query, then loads the catalog info (types, enums,
 * nullability) needed to turn type OIDs into TypeScript.
 */

import type { ParsedQuery } from "./sqlfile.ts";
import { rewriteNamedParams } from "./params.ts";
import type { AnalyzedQuery } from "./model.ts";
import { attrKey, type TypeInfo } from "./typemap.ts";
import type { IntrospectionEngine } from "./engine.ts";
import {
  columnRefsInExpression,
  fromAliases,
  inferNonNullExpression,
  selectExpressions,
} from "./nullability.ts";

export interface AnalyzeOptions {
  engine: IntrospectionEngine;
  queries: ParsedQuery[];
  /** Schema SQL (from a schema file or migrations) applied before introspection. */
  schema?: string;
  progress?: (message: string) => void;
}

export interface AnalyzeResult {
  analyzed: AnalyzedQuery[];
  typeInfo: TypeInfo;
  /** Key is `${tableOid}:${attnum}`; value is whether the column is NOT NULL. */
  notNull: Map<string, boolean>;
  errors: { name: string; error: string }[];
}

export async function analyzeQueries(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const { engine } = opts;
  opts.progress?.("applying schema");
  await engine.applySchema(opts.schema ?? "");

  const analyzed: AnalyzedQuery[] = [];
  const errors: { name: string; error: string }[] = [];

  opts.progress?.(
    `describing ${opts.queries.length} quer${opts.queries.length === 1 ? "y" : "ies"}`,
  );
  for (const query of opts.queries) {
    opts.progress?.(`describing query ${query.name}`);
    const rewritten = rewriteNamedParams(query.sql);
    try {
      const shape = await engine.describe(rewritten.introspectText);
      opts.progress?.(`inferring query nullability ${query.name}`);
      const inferredNotNullColumns = inferQueryNotNullColumns(
        query.sql,
        query.nonNullColumns,
        shape,
      );
      opts.progress?.(`inferred query nullability ${query.name}`);
      analyzed.push({
        query,
        rewritten,
        shape,
        inferredNotNullColumns,
      });
    } catch (e: any) {
      errors.push({ name: query.name, error: e?.message ?? String(e) });
      opts.progress?.(`query ${query.name} failed: ${e?.message ?? e}`);
    }
  }

  opts.progress?.("loading PostgreSQL type catalog");
  const typeInfo = await loadTypeInfo(engine);
  opts.progress?.("loading column nullability catalog");
  const notNull = await loadNotNull(engine, analyzed, opts.progress);

  return { analyzed, typeInfo, notNull, errors };
}

function inferQueryNotNullColumns(
  _sql: string,
  manualNames: string[] | undefined,
  shape: Awaited<ReturnType<IntrospectionEngine["describe"]>>,
): Set<number> {
  // Keep per-query inference fully bounded. Table/view column nullability,
  // including view lineage, is handled later in loadNotNull from Postgres
  // metadata. This pass only applies explicit user assertions; parsing arbitrary
  // query SQL here can wedge on real-world query text.
  const out = new Set<number>();
  if (!manualNames?.length || !shape.columns?.length) return out;

  const manual = new Set(manualNames);
  shape.columns.forEach((col, idx) => {
    if (manual.has(col.name)) out.add(idx);
  });
  return out;
}

async function loadTypeInfo(engine: IntrospectionEngine): Promise<TypeInfo> {
  const types: TypeInfo["types"] = new Map();
  const enums = new Map<number, string[]>();

  const typeRows = await engine.queryRows(
    `SELECT oid::int4 AS oid, typname, typtype, typcategory,
            typelem::int4 AS typelem, typbasetype::int4 AS typbasetype
     FROM pg_type`,
  );
  for (const r of typeRows) {
    types.set(r.oid, {
      oid: r.oid,
      name: r.typname,
      typtype: r.typtype,
      typcategory: r.typcategory,
      typelem: r.typelem,
      typbasetype: r.typbasetype,
    });
  }

  const enumRows = await engine.queryRows(
    `SELECT enumtypid::int4 AS oid, enumlabel
     FROM pg_enum
     ORDER BY enumtypid, enumsortorder`,
  );
  for (const r of enumRows) {
    const list = enums.get(r.oid) ?? [];
    list.push(r.enumlabel);
    enums.set(r.oid, list);
  }

  return { types, enums };
}

async function loadNotNull(
  engine: IntrospectionEngine,
  analyzed: AnalyzedQuery[],
  progress?: (message: string) => void,
): Promise<Map<string, boolean>> {
  const pairs: [number, number][] = [];
  const seen = new Set<string>();

  for (const a of analyzed) {
    for (const col of a.shape.columns ?? []) {
      if (col.tableOid > 0 && col.columnAttr > 0) {
        const key = attrKey(col.tableOid, col.columnAttr);
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push([col.tableOid, col.columnAttr]);
        }
      }
    }
  }

  const map = new Map<string, boolean>();
  if (pairs.length === 0) return map;

  progress?.(`loading nullability for ${pairs.length} column reference(s)`);
  // Inline the (oid, attnum) pairs as a VALUES list. They come from
  // introspection, never user input, so there is nothing to escape.
  const values = pairs.map(([rel, att]) => `(${rel},${att})`).join(",");
  const rows = await engine.queryRows(
    `SELECT a.attrelid::int4 AS relid, a.attnum::int4 AS attnum, a.attnotnull,
            a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS generated_expr,
            c.relkind,
            CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END AS viewdef
     FROM (VALUES ${values}) AS t(relid, attnum)
     JOIN pg_attribute a ON a.attrelid = t.relid::oid AND a.attnum = t.attnum
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     JOIN pg_class c ON c.oid = a.attrelid`,
  );
  for (const r of rows) {
    let isNotNull = r.attnotnull === true;
    if (!isNotNull && r.attgenerated && typeof r.generated_expr === "string") {
      progress?.(`inferring generated-column nullability ${r.relid}.${r.attnum}`);
      isNotNull = inferNonNullExpression(r.generated_expr);
    }
    if (!isNotNull && (r.relkind === "v" || r.relkind === "m") && typeof r.viewdef === "string") {
      progress?.(`inferring view-column nullability ${r.relid}.${r.attnum}`);
      isNotNull = (await inferViewNotNullColumns(engine, r.viewdef)).has(r.attnum - 1);
    }
    map.set(attrKey(r.relid, r.attnum), isNotNull);
  }
  progress?.("loaded column nullability catalog");
  return map;
}

async function inferViewNotNullColumns(
  engine: IntrospectionEngine,
  viewdef: string,
): Promise<Set<number>> {
  return inferSqlNotNullColumns(engine, viewdef);
}

async function inferSqlNotNullColumns(
  engine: IntrospectionEngine,
  sql: string,
): Promise<Set<number>> {
  const out = new Set<number>();
  if (!sql.includes(".")) return out;

  const aliases = new Map(fromAliases(sql).map((a) => [a.alias, a]));
  const refs = new Map<string, { relation: string; column: string }>();
  const expressions = selectExpressions(sql);

  expressions.forEach((expr) => {
    for (const ref of columnRefsInExpression(expr)) {
      const source = aliases.get(ref.table);
      if (!source || source.nullable) continue;
      const key = `${source.relation}\0${ref.column}`;
      refs.set(key, { relation: source.relation, column: ref.column });
    }
  });

  if (refs.size === 0) return out;

  const values = [...refs.values()]
    .map((r) => `(${sqlString(r.relation)},${sqlString(r.column)})`)
    .join(",");
  const rows = await engine.queryRows(
    `SELECT refs.relation, refs.column_name, a.attnotnull,
            a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS generated_expr
     FROM (VALUES ${values}) AS refs(relation, column_name)
     JOIN pg_class c ON c.oid = to_regclass(refs.relation)
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = refs.column_name
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum`,
  );
  const notNullRefs = new Set(
    rows
      .filter(
        (r) =>
          r.attnotnull === true ||
          (r.attgenerated && typeof r.generated_expr === "string"
            ? inferNonNullExpression(r.generated_expr)
            : false),
      )
      .map((r) => `${r.relation}\0${r.column_name}`),
  );

  const isNonNullColumn = (ref: { table: string; column: string }) => {
    const source = aliases.get(ref.table);
    return !!source && !source.nullable && notNullRefs.has(`${source.relation}\0${ref.column}`);
  };

  expressions.forEach((expr, idx) => {
    if (inferNonNullExpression(expr, { isNonNullColumn })) out.add(idx);
  });

  return out;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
