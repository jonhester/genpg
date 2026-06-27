/**
 * Runtime support imported by application code (not by generated files, which
 * inline their own copy of `Queryable`).
 *
 * Generated functions take a `Queryable`. node-postgres `Client`/`Pool` already
 * satisfy it; other drivers use a thin adapter.
 */

export interface QueryResultLike {
  rows: any[];
  rowCount: number | null;
}

export interface Queryable {
  query(text: string, values: unknown[]): Promise<QueryResultLike>;
}

/**
 * Identity adapter for node-postgres. A `pg` `Client` or `Pool` is already a
 * `Queryable`; this just provides a typed, explicit entry point.
 */
export function fromPg<T extends Queryable>(client: T): Queryable {
  return client;
}

/**
 * Run `fn` inside a transaction using a dedicated node-postgres pooled client.
 * Commits on success, rolls back on any thrown error, and always releases the
 * client. The `tx` passed to `fn` is a `Queryable`, so generated query functions
 * called with it all run on the same transaction.
 *
 *   await withTransaction(pool, async (tx) => {
 *     const user = await insertUser(tx, { email });
 *     await insertProfile(tx, { userId: user.id });
 *   });
 */
export interface PgPoolClientLike extends Queryable {
  release(err?: unknown): void;
}
export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
}

export async function withTransaction<T>(
  pool: PgPoolLike,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN", []);
    const result = await fn(client);
    await client.query("COMMIT", []);
    return result;
  } catch (err) {
    await client.query("ROLLBACK", []).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The slice of the postgres.js `Sql` instance we rely on. */
export interface PostgresJsSql {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<any>;
  begin?<T>(fn: (sql: PostgresJsSql) => Promise<T>): Promise<T>;
}

/**
 * Run `fn` inside a postgres.js transaction. Delegates to `sql.begin`, wrapping
 * the transaction-scoped `sql` as a `Queryable`.
 */
export async function withPostgresJsTransaction<T>(
  sql: PostgresJsSql,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!sql.begin) {
    throw new Error("This postgres.js instance does not support begin().");
  }
  return sql.begin((txSql) => fn(fromPostgresJs(txSql)));
}

/**
 * Adapter for postgres.js (porsager). Generated code produces a `$1..$n` string
 * plus a positional values array, which we run via `sql.unsafe`.
 */
export function fromPostgresJs(sql: PostgresJsSql): Queryable {
  return {
    async query(text: string, values: unknown[]): Promise<QueryResultLike> {
      const result: any = await sql.unsafe(text, values as unknown[]);
      const rows = Array.isArray(result) ? result : Array.from(result ?? []);
      const rowCount = typeof result?.count === "number" ? result.count : rows.length;
      return { rows, rowCount };
    },
  };
}
