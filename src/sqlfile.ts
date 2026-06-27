/**
 * Parsing of annotated `.sql` query files (sqlc-style).
 *
 * Each query is introduced by a marker comment:
 *
 *   -- name: GetUser :one
 *   SELECT id, email FROM users WHERE id = @id;
 *
 * The name becomes the generated function/type name; the command after the
 * colon controls the generated return shape.
 */

export type QueryCommand = "one" | "many" | "exec" | "execrows";

export interface ParsedQuery {
  /** Name from the annotation, e.g. "GetUser". */
  name: string;
  command: QueryCommand;
  /** Raw SQL body (trailing semicolon stripped), still using `@name` params. */
  sql: string;
}

const COMMANDS: ReadonlySet<string> = new Set(["one", "many", "exec", "execrows"]);
const NAME_RE = /^\s*--\s*name:\s*(\S+)\s+:(\w+)\s*$/;

export function parseQueryFile(content: string, file = "<input>"): ParsedQuery[] {
  const lines = content.split(/\r?\n/);
  const queries: ParsedQuery[] = [];

  let current: { name: string; command: QueryCommand; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const sql = current.body.join("\n").trim().replace(/;\s*$/, "").trim();
    if (sql) queries.push({ name: current.name, command: current.command, sql });
    current = null;
  };

  for (const line of lines) {
    const m = NAME_RE.exec(line);
    if (m) {
      flush();
      const name = m[1];
      const command = m[2];
      if (!COMMANDS.has(command)) {
        throw new Error(
          `${file}: unknown command ":${command}" for query "${name}" ` +
            `(expected one of :one, :many, :exec, :execrows)`,
        );
      }
      current = { name, command: command as QueryCommand, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();

  return queries;
}
