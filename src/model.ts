/** Shared data shapes produced by introspection and consumed by codegen. */

import type { ParsedQuery } from "./sqlfile.ts";
import type { RewrittenQuery } from "./params.ts";

export interface QueryColumn {
  /** Result column name as returned by Postgres. */
  name: string;
  /** Source table OID (0 if computed/expression). */
  tableOid: number;
  /** Source column attribute number (0 if computed/expression). */
  columnAttr: number;
  /** Type OID of the column. */
  typeOid: number;
}

export interface QueryShape {
  /** Type OID of each positional parameter ($1..$n). */
  params: number[];
  /** Result columns, or null when the statement returns no rows (NoData). */
  columns: QueryColumn[] | null;
}

export interface AnalyzedQuery {
  query: ParsedQuery;
  rewritten: RewrittenQuery;
  shape: QueryShape;
}
