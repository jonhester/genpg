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
      analyzed.push({ query, rewritten, shape });
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
    `SELECT a.attrelid::int4 AS relid, a.attnum::int4 AS attnum, a.attnotnull
     FROM (VALUES ${values}) AS t(relid, attnum)
     JOIN pg_attribute a ON a.attrelid = t.relid::oid AND a.attnum = t.attnum`,
  );
  for (const r of rows) {
    map.set(attrKey(r.relid, r.attnum), r.attnotnull === true);
  }
  return map;
}
