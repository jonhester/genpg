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
  /** Leading prose comments after the annotation, emitted as generated JSDoc. */
  docs?: string[];
  /** Optional deprecation reason from a leading `@deprecated ...` doc line. */
  deprecated?: string;
  /** Result column names the user asserts are non-null. */
  nonNullColumns?: string[];
  /** Raw SQL body (trailing semicolon stripped), still using `@name` params. */
  sql: string;
}

const COMMANDS: ReadonlySet<string> = new Set(["one", "many", "exec", "execrows"]);
const NAME_RE = /^\s*--\s*name:\s*(\S+)\s+:(\w+)\s*$/;
const LINE_DOC_RE = /^\s*--(?!\s*name:)(.*)$/;
const NONNULL_RE = /^\s*--\s*nonnull:\s*(.+?)\s*$/i;
const BLOCK_DOC_START_RE = /^\s*\/\*(.*)$/;
const DEPRECATED_RE = /^@deprecated(?:\s+(.+))?$/i;

export function parseQueryFile(content: string, file = "<input>"): ParsedQuery[] {
  const lines = content.split(/\r?\n/);
  const queries: ParsedQuery[] = [];

  let current: {
    name: string;
    command: QueryCommand;
    docs: string[];
    deprecated?: string;
    nonNullColumns: string[];
    body: string[];
    beforeSql: boolean;
    inBlockDoc: boolean;
    sqlTerminated: boolean;
  } | null = null;

  let outsideBlockComment = false;

  const flush = () => {
    if (!current) return;
    const sql = current.body.join("\n").trim().replace(/;\s*$/, "").trim();
    const docs = trimDocLines(current.docs);
    if (sql) {
      queries.push({
        name: current.name,
        command: current.command,
        ...(docs.length > 0 ? { docs } : {}),
        ...(current.deprecated ? { deprecated: current.deprecated } : {}),
        nonNullColumns: current.nonNullColumns,
        sql,
      });
    }
    current = null;
  };

  for (const [idx, line] of lines.entries()) {
    const lineNo = idx + 1;
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
      current = {
        name,
        command: command as QueryCommand,
        docs: [],
        nonNullColumns: [],
        body: [],
        beforeSql: true,
        inBlockDoc: false,
        sqlTerminated: false,
      };
      continue;
    }
    if (current) {
      if (current.sqlTerminated) {
        if (outsideBlockComment) {
          if (line.includes("*/")) outsideBlockComment = false;
          continue;
        }

        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("--")) continue;
        if (trimmed.startsWith("/*")) {
          outsideBlockComment = !trimmed.includes("*/");
          continue;
        }
        throw unannotatedSqlError(file, lineNo);
      }

      if (current.inBlockDoc) {
        const end = line.indexOf("*/");
        if (end >= 0) {
          addDocLine(current, cleanBlockDocLine(line.slice(0, end)));
          current.inBlockDoc = false;
          const rest = line.slice(end + 2);
          if (rest.trim()) {
            current.beforeSql = false;
            current.body.push(rest.trimStart());
            current.sqlTerminated = sqlLineTerminates(rest);
          }
        } else {
          addDocLine(current, cleanBlockDocLine(line));
        }
        continue;
      }

      const nonnull = NONNULL_RE.exec(line);
      if (nonnull) {
        current.nonNullColumns.push(...parseColumnList(nonnull[1]));
        continue;
      }

      if (current.beforeSql) {
        const lineDoc = LINE_DOC_RE.exec(line);
        if (lineDoc) {
          addDocLine(current, cleanLineDocLine(lineDoc[1]));
          continue;
        }

        const blockDoc = BLOCK_DOC_START_RE.exec(line);
        if (blockDoc) {
          const end = blockDoc[1].indexOf("*/");
          if (end >= 0) {
            addDocLine(current, cleanBlockDocLine(blockDoc[1].slice(0, end)));
            const rest = blockDoc[1].slice(end + 2);
            if (rest.trim()) {
              current.beforeSql = false;
              current.body.push(rest.trimStart());
              current.sqlTerminated = sqlLineTerminates(rest);
            }
          } else {
            addDocLine(current, cleanBlockDocLine(blockDoc[1]));
            current.inBlockDoc = true;
          }
          continue;
        }

        if (!line.trim()) continue;
        current.beforeSql = false;
      }

      current.body.push(line);
      if (sqlLineTerminates(line)) current.sqlTerminated = true;
      continue;
    }

    if (outsideBlockComment) {
      if (line.includes("*/")) outsideBlockComment = false;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;
    if (trimmed.startsWith("/*")) {
      outsideBlockComment = !trimmed.includes("*/");
      continue;
    }
    throw unannotatedSqlError(file, lineNo);
  }
  flush();

  return queries;
}

function addDocLine(
  current: {
    docs: string[];
    deprecated?: string;
  },
  raw: string,
): void {
  const line = raw.trimEnd();
  const deprecated = DEPRECATED_RE.exec(line.trim());
  if (deprecated) {
    current.deprecated = deprecated[1]?.trim() ?? "";
    return;
  }
  current.docs.push(line);
}

function cleanLineDocLine(raw: string): string {
  return raw.replace(/^ ?/, "");
}

function cleanBlockDocLine(raw: string): string {
  return raw.replace(/^\s*\* ?/, "").trimEnd();
}

function trimDocLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function sqlLineTerminates(line: string): boolean {
  return /;\s*$/.test(line);
}

function unannotatedSqlError(file: string, line: number): Error {
  return new Error(
    `${file}:${line}: SQL query is missing a preceding "-- name: <Name> :<command>" annotation.`,
  );
}

function parseColumnList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}
