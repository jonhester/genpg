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
  fromAliases,
  inferNonNullOutputColumns,
  selectExpressions,
  simpleColumnRef,
} from "./nullability.ts";

export interface AnalyzeOptions {
  engine: IntrospectionEngine;
  queries: ParsedQuery[];
  /** Schema SQL (from a schema file or migrations) applied before introspection. */
  schema?: string;
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
  await engine.applySchema(opts.schema ?? "");

  const analyzed: AnalyzedQuery[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const query of opts.queries) {
    const rewritten = rewriteNamedParams(query.sql);
    try {
      const shape = await engine.describe(rewritten.introspectText);
      analyzed.push({
        query,
        rewritten,
        shape,
        inferredNotNullColumns: inferNonNullOutputColumns(query.sql),
      });
    } catch (e: any) {
      errors.push({ name: query.name, error: e?.message ?? String(e) });
    }
  }

  const typeInfo = await loadTypeInfo(engine);
  const notNull = await loadNotNull(engine, analyzed);

  return { analyzed, typeInfo, notNull, errors };
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

  // Inline the (oid, attnum) pairs as a VALUES list. They come from
  // introspection, never user input, so there is nothing to escape.
  const values = pairs.map(([rel, att]) => `(${rel},${att})`).join(",");
  const rows = await engine.queryRows(
    `SELECT a.attrelid::int4 AS relid, a.attnum::int4 AS attnum, a.attnotnull,
            c.relkind, pg_get_viewdef(c.oid) AS viewdef
     FROM (VALUES ${values}) AS t(relid, attnum)
     JOIN pg_attribute a ON a.attrelid = t.relid::oid AND a.attnum = t.attnum
     JOIN pg_class c ON c.oid = a.attrelid`,
  );
  for (const r of rows) {
    let isNotNull = r.attnotnull === true;
    if (!isNotNull && (r.relkind === "v" || r.relkind === "m") && typeof r.viewdef === "string") {
      isNotNull = (await inferViewNotNullColumns(engine, r.viewdef)).has(r.attnum - 1);
    }
    map.set(attrKey(r.relid, r.attnum), isNotNull);
  }
  return map;
}

async function inferViewNotNullColumns(
  engine: IntrospectionEngine,
  viewdef: string,
): Promise<Set<number>> {
  const out = inferNonNullOutputColumns(viewdef);
  const aliases = new Map(fromAliases(viewdef).map((a) => [a.alias, a]));
  const refs = new Map<string, { relation: string; column: string }>();

  selectExpressions(viewdef).forEach((expr) => {
    const ref = simpleColumnRef(expr);
    if (!ref) return;
    const source = aliases.get(ref.table);
    if (!source || source.nullable) return;
    const key = `${source.relation}\0${ref.column}`;
    refs.set(key, { relation: source.relation, column: ref.column });
  });

  if (refs.size === 0) return out;

  const values = [...refs.values()]
    .map((r) => `(${sqlString(r.relation)},${sqlString(r.column)})`)
    .join(",");
  const rows = await engine.queryRows(
    `SELECT refs.relation, refs.column_name, a.attnotnull
     FROM (VALUES ${values}) AS refs(relation, column_name)
     JOIN pg_class c ON c.oid = to_regclass(refs.relation)
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = refs.column_name`,
  );
  const notNullRefs = new Set(
    rows.filter((r) => r.attnotnull === true).map((r) => `${r.relation}\0${r.column_name}`),
  );

  selectExpressions(viewdef).forEach((expr, idx) => {
    const ref = simpleColumnRef(expr);
    if (!ref) return;
    const source = aliases.get(ref.table);
    if (!source || source.nullable) return;
    if (notNullRefs.has(`${source.relation}\0${ref.column}`)) out.add(idx);
  });

  return out;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
