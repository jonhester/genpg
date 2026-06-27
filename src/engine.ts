/** PostgreSQL introspection engine backed by node-postgres. */

import { Client, type Connection, type FieldDef } from "pg";
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

interface ParameterDescription {
  dataTypeIDs: number[];
}

interface RowDescription {
  fields: FieldDef[];
}

/**
 * A real PostgreSQL engine. Schema replay and catalog inspection share one
 * transaction, which is always rolled back when generation finishes.
 */
export class PgEngine implements IntrospectionEngine {
  private constructor(private readonly client: Client) {}

  static async create(connectionString: string): Promise<PgEngine> {
    const client = new Client({ connectionString, application_name: "genpg" });
    await client.connect();
    try {
      await client.query("BEGIN");
      return new PgEngine(client);
    } catch (error) {
      await client.end();
      throw error;
    }
  }

  async applySchema(sql: string): Promise<void> {
    if (sql.trim()) await this.client.query(sql);
  }

  async describe(sql: string): Promise<QueryShape> {
    const savepoint = "genpg_describe";
    await this.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const shape = await this.describeRaw(sql);
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return shape;
    } catch (error) {
      // Parse errors abort the current transaction. Rewind only this query so
      // analysis can report it and continue describing the remaining queries.
      await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  private async describeRaw(sql: string): Promise<QueryShape> {
    return new Promise<QueryShape>((resolve, reject) => {
      let params: number[] = [];
      let columns: QueryColumn[] | null = null;
      let settled = false;
      const connection = this.client.connection;

      const onParameterDescription = (message: ParameterDescription): void => {
        params = message.dataTypeIDs;
      };
      const onNoData = (): void => {
        columns = [];
      };
      const cleanup = (): void => {
        connection.off("parameterDescription", onParameterDescription);
        connection.off("noData", onNoData);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve({ params, columns });
      };

      const query = {
        submit(conn: Connection): void {
          connection.on("parameterDescription", onParameterDescription);
          connection.on("noData", onNoData);
          conn.parse({ name: "", text: sql, types: [] }, true);
          conn.describe({ type: "S", name: "" }, true);
          conn.sync();
        },
        handleRowDescription(message: RowDescription): void {
          columns = message.fields.map(toColumn);
        },
        handleError(error: Error): void {
          finish(error);
        },
        handleReadyForQuery(): void {
          finish();
        },
      };

      this.client.query(query);
    });
  }

  async queryRows(sql: string): Promise<any[]> {
    const result = await this.client.query(sql);
    return result.rows;
  }

  async dispose(): Promise<void> {
    try {
      await this.client.query("ROLLBACK");
    } finally {
      await this.client.end();
    }
  }
}
