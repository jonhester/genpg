/**
 * Introspection engine: in-process Postgres (PGlite, compiled to WASM).
 *
 * No server, no Docker, no connection string — codegen runs anywhere, including
 * CI, with zero services. The schema/migrations are applied to a fresh in-memory
 * database, then each query is Parse/Described to read its parameter and result
 * types. Nothing is ever executed, so there are no side effects.
 */

import { PGlite, protocol } from "@electric-sql/pglite";
import type { QueryColumn, QueryShape } from "./model.ts";

export interface IntrospectionEngine {
  /** Apply schema/DDL (may contain multiple statements). */
  applySchema(sql: string): Promise<void>;
  /** Parse + Describe a statement without executing it. Throws on SQL errors. */
  describe(sql: string): Promise<QueryShape>;
  /** Run a read-only catalog query and return its rows. */
  queryRows(sql: string): Promise<any[]>;
  /** Release all resources. */
  dispose(): Promise<void>;
}

function toColumn(f: any): QueryColumn {
  return {
    name: f.name,
    tableOid: f.tableID,
    columnAttr: f.columnID,
    typeOid: f.dataTypeID,
  };
}

/** Build a QueryShape from the backend messages of a Describe round-trip. */
function shapeFromMessages(messages: any[]): QueryShape {
  let params: number[] = [];
  let columns: QueryColumn[] | null = null;
  for (const m of messages) {
    switch (m?.name) {
      case "parameterDescription":
        params = m.dataTypeIDs as number[];
        break;
      case "rowDescription":
        columns = (m.fields as any[]).map(toColumn);
        break;
      case "noData":
        if (columns === null) columns = [];
        break;
      case "error":
        throw new Error(m.message ?? "describe failed");
    }
  }
  return { params, columns };
}

export class PgliteEngine implements IntrospectionEngine {
  private constructor(private readonly db: PGlite) {}

  static async create(): Promise<PgliteEngine> {
    return new PgliteEngine(await PGlite.create());
  }

  async applySchema(sql: string): Promise<void> {
    if (sql.trim()) await this.db.exec(sql);
  }

  async describe(sql: string): Promise<QueryShape> {
    // A Parse error in the raw protocol wedges the WASM backend, but PGlite's
    // high-level query() recovers from errors cleanly. So we validate the SQL by
    // PREPARE-ing it (throws a readable error if invalid, recoverably), then run
    // the protocol Describe only on the now-known-valid prepared statement.
    const name = "genpg_describe_stmt";
    await this.db.query(`DEALLOCATE ${name}`).catch(() => {});
    await this.db.query(`PREPARE ${name} AS ${sql}`);
    try {
      const { serialize } = protocol;
      const message = Buffer.concat([serialize.describe({ type: "S", name }), serialize.sync()]);
      const { messages } = await this.db.execProtocol(message);
      return shapeFromMessages(messages as any[]);
    } finally {
      await this.db.query(`DEALLOCATE ${name}`).catch(() => {});
    }
  }

  async queryRows(sql: string): Promise<any[]> {
    const res = await this.db.query(sql);
    return res.rows as any[];
  }

  async dispose(): Promise<void> {
    await this.db.close();
  }
}
