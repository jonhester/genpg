/**
 * Named-parameter parsing.
 *
 * Users write `@name` placeholders, optionally with a marker:
 *   @name      scalar, non-null (default)
 *   @name!     scalar, non-null (explicit)
 *   @name?     scalar, nullable
 *   @name(array)   array param — expanded to `($1, $2, ...)` at runtime (for `IN`)
 *   @name(spread)  spread param — array of row tuples expanded to `($1,$2),($3,$4)`
 *                  for bulk `INSERT ... VALUES @name(spread)`
 *
 * PostgreSQL only understands positional `$1, $2`, so we parse the query into
 * literal segments interleaved with parameter references. Scalar-only queries
 * render to a fixed `$1..$n` string; queries with array/spread params build their
 * SQL at call time (the placeholder count depends on the array length).
 *
 * Substitution is skipped inside string literals, quoted identifiers,
 * dollar-quoted strings, and comments.
 */

export type ParamKind = "scalar" | "array" | "spread";

export interface QueryParam {
  name: string;
  kind: ParamKind;
  /** Scalar nullability (true => `T | null`). */
  nullable: boolean;
  /** Spread tuple column names, in order (only for `spread`). */
  fields?: string[];
  /** 1-based ParameterDescription positions this param occupies. */
  placeholders: number[];
}

/** A literal SQL chunk, or a reference to `params[param]`. */
export type SqlSegment = string | { param: number };

export interface RewrittenQuery {
  segments: SqlSegment[];
  params: QueryParam[];
  /** `$1..$n` text used to introspect the query (one tuple per spread). */
  introspectText: string;
  /** True when any param is `array`/`spread` (SQL must be built at runtime). */
  dynamic: boolean;
}

const PARAM_RE = /^@([A-Za-z_]\w*)(?:(!|\?)|\(\s*(array|spread)\s*\))?/;
const DOLLAR_TAG_RE = /^\$([A-Za-z_]\w*)?\$/;
// Finds the insert column list for a spread param: INSERT INTO t (a, b) ... VALUES @name(spread)
const SPREAD_COLUMNS_RE =
  /insert\s+into\s+[\w."]+\s*\(([^)]+)\)[\s\S]*?values\s*@(\w+)\s*\(\s*spread\s*\)/gi;

export function rewriteNamedParams(sql: string): RewrittenQuery {
  const spreadFields = extractSpreadFields(sql);

  const segments: SqlSegment[] = [];
  const params: QueryParam[] = [];
  const indexByName = new Map<string, number>();
  let literal = "";
  let i = 0;
  const n = sql.length;

  const pushLiteral = () => {
    if (literal) {
      segments.push(literal);
      literal = "";
    }
  };

  while (i < n) {
    const c = sql[i];

    // Line comment
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      literal += sql.slice(i, end);
      i = end;
      continue;
    }
    // Block comment (nestable)
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      literal += sql.slice(i, j);
      i = j;
      continue;
    }
    // Single-quoted string / double-quoted identifier
    if (c === "'" || c === '"') {
      const j = scanQuoted(sql, i, c);
      literal += sql.slice(i, j);
      i = j;
      continue;
    }
    // Dollar-quoted string
    if (c === "$") {
      const m = DOLLAR_TAG_RE.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        literal += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    // Named parameter
    if (c === "@") {
      const m = PARAM_RE.exec(sql.slice(i));
      if (m) {
        const name = m[1];
        const marker = m[2];
        const collection = m[3];
        const kind: ParamKind =
          collection === "array" ? "array" : collection === "spread" ? "spread" : "scalar";

        let idx = indexByName.get(name);
        if (idx === undefined) {
          idx = params.length;
          indexByName.set(name, idx);
          const param: QueryParam = {
            name,
            kind,
            nullable: marker === "?",
            placeholders: [],
          };
          if (kind === "spread") {
            const fields = spreadFields.get(name);
            if (!fields) {
              throw new Error(
                `Spread param @${name}(spread) must be used as ` +
                  `INSERT INTO <table> (col, ...) VALUES @${name}(spread).`,
              );
            }
            param.fields = fields;
          }
          params.push(param);
        } else {
          const existing = params[idx];
          const nullable = marker === "?";
          if (existing.kind !== kind || existing.nullable !== nullable) {
            throw new Error(
              `Parameter @${name} is used with inconsistent markers; ` +
                `reuse one spelling such as @${name}, @${name}?, @${name}(array), or @${name}(spread).`,
            );
          }
          if (kind === "spread") {
            const fields = spreadFields.get(name);
            if (!sameFields(existing.fields ?? [], fields ?? [])) {
              throw new Error(
                `Spread parameter @${name}(spread) is used with inconsistent fields.`,
              );
            }
          }
        }

        pushLiteral();
        segments.push({ param: idx });
        i += m[0].length;
        continue;
      }
    }

    literal += c;
    i++;
  }
  pushLiteral();

  // Assign placeholder positions in first-occurrence (param array) order.
  let pos = 1;
  for (const p of params) {
    const count = p.kind === "spread" ? p.fields!.length : 1;
    p.placeholders = Array.from({ length: count }, () => pos++);
  }

  const introspectText = renderIntrospectText(segments, params);
  const dynamic = params.some((p) => p.kind !== "scalar");

  return { segments, params, introspectText, dynamic };
}

function sameFields(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((field, idx) => field === b[idx]);
}

/** Render the `$1..$n` text used for Parse/Describe (arrays/spreads -> one tuple). */
function renderIntrospectText(segments: SqlSegment[], params: QueryParam[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "string") {
      out += seg;
      continue;
    }
    const p = params[seg.param];
    const phs = p.placeholders.map((n) => `$${n}`);
    if (p.kind === "array") out += `(${phs[0]})`;
    else if (p.kind === "spread") out += `(${phs.join(", ")})`;
    else out += phs[0];
  }
  return out;
}

function extractSpreadFields(sql: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of sql.matchAll(SPREAD_COLUMNS_RE)) {
    const cols = m[1]
      .split(",")
      .map((c) => c.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean);
    const name = m[2];
    const existing = map.get(name);
    if (existing && !sameFields(existing, cols)) {
      throw new Error(`Spread parameter @${name}(spread) is used with inconsistent fields.`);
    }
    map.set(name, cols);
  }
  return map;
}

function scanQuoted(sql: string, start: number, quote: string): number {
  let j = start + 1;
  const n = sql.length;
  while (j < n) {
    if (sql[j] === quote && sql[j + 1] === quote) {
      j += 2;
      continue;
    }
    if (sql[j] === quote) return j + 1;
    j++;
  }
  return n;
}
