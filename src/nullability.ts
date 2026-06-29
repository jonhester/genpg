/**
 * Small, intentionally conservative SQL nullability heuristics.
 *
 * PostgreSQL's Describe tells us output types, but expression/view nullability is
 * often reported as nullable even for obvious non-null expressions. This module
 * only handles cases we can recognize cheaply and safely.
 */

/** Return 0-based output column indexes that are visibly non-null. */
export function inferNonNullOutputColumns(sql: string): Set<number> {
  const list = selectExpressions(sql);
  const out = new Set<number>();

  list.forEach((item, idx) => {
    if (inferNonNullExpression(item)) out.add(idx);
  });
  return out;
}

/**
 * Query-local inference that deliberately only recognizes COALESCE fallbacks.
 * This is safe to run on user query text because it does not chase source-column
 * lineage or recurse through arbitrary expression trees.
 */
export function inferCoalesceFallbackOutputColumns(sql: string): Set<number> {
  const out = new Set<number>();
  if (!/\bcoalesce\s*\(/i.test(sql) || sql.length > 50_000) return out;

  selectExpressions(sql).forEach((expr, idx) => {
    if (hasNonNullCoalesceFallback(expr)) out.add(idx);
  });
  return out;
}

export interface ExpressionInferenceOptions {
  isNonNullColumn?: (ref: ColumnRef) => boolean;
  depth?: number;
}

function hasNonNullCoalesceFallback(expr: string): boolean {
  const args = callArgs(stripOuterCasts(stripOuterParens(expr.trim())), "coalesce");
  return args?.some((arg) => isNonNullLiteral(arg)) === true;
}

/** True when a standalone SQL expression is visibly non-null. */
export function inferNonNullExpression(
  expr: string,
  options: ExpressionInferenceOptions = {},
): boolean {
  return isNonNullExpression(expr, options);
}

export interface ColumnRef {
  table: string;
  column: string;
}

export interface FromAlias {
  alias: string;
  relation: string;
  nullable: boolean;
}

/** Select-list expressions without aliases, in output order. */
export function selectExpressions(sql: string): string[] {
  const list = topLevelSelectList(sql);
  return list?.map(stripAlias) ?? [];
}

/** A simple `alias.column` expression, after alias/cast/parens stripping. */
export function simpleColumnRef(expr: string): ColumnRef | null {
  const s = stripOuterCasts(stripOuterParens(expr.trim()));
  const m = /^((?:"(?:[^"]|"")+"|[A-Za-z_]\w*)+)\.("(?:[^"]|"")+"|[A-Za-z_]\w*)$/.exec(s);
  if (!m) return null;
  return { table: unquoteIdent(m[1]!), column: unquoteIdent(m[2]!) };
}

/** Best-effort extraction of `alias.column` refs used inside an expression. */
export function columnRefsInExpression(expr: string): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const re = /((?:"(?:[^"]|"")+"|[A-Za-z_]\w*)+)\.("(?:[^"]|"")+"|[A-Za-z_]\w*)/g;
  for (const m of stripStringsAndComments(expr).matchAll(re)) {
    refs.push({ table: unquoteIdent(m[1]!), column: unquoteIdent(m[2]!) });
  }
  return refs;
}

/**
 * Extract simple base relation aliases from a FROM/JOIN list. Nullable marks the
 * alias as coming from the optional side of an outer join.
 */
export function fromAliases(sql: string): FromAlias[] {
  const from = topLevelFromClause(sql);
  if (!from) return [];

  const out: FromAlias[] = [];
  const relationPattern =
    /\b(from|(?:left|right|full|cross|inner)?\s*join|join)\s+\(*\s*(?:only\s+)?((?:"(?:[^"]|"")+"|[A-Za-z_]\w*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_]\w*))?)(?:\s+(?:as\s+)?(?!(?:left|right|full|cross|inner|join|where|on|group|order|limit)\b)("(?:[^"]|"")+"|[A-Za-z_]\w*))?/gi;

  for (const m of from.matchAll(relationPattern)) {
    const kind = m[1]!.replace(/\s+/g, " ").trim().toLowerCase();
    const relation = normalizeRelationName(m[2]!);
    if (relation.toLowerCase() === "select") continue;
    const alias = m[3] ? unquoteIdent(m[3]) : relation.split(".").at(-1)!;
    const nullable = kind.startsWith("left") || kind.startsWith("full");

    if (kind.startsWith("right") || kind.startsWith("full")) {
      for (const prev of out) prev.nullable = true;
    }
    out.push({ alias, relation, nullable });
  }
  return out;
}

const STRICT_FUNCTIONS = new Set([
  "date_trunc",
  "lower",
  "upper",
  "trim",
  "btrim",
  "ltrim",
  "rtrim",
]);

function isNonNullExpression(expr: string, options: ExpressionInferenceOptions): boolean {
  const depth = options.depth ?? 0;
  if (depth > 20 || expr.length > 2000) return false;
  const nextOptions = { ...options, depth: depth + 1 };
  const castless = stripOuterCasts(stripOuterParens(expr.trim()));
  if (isNonNullLiteral(castless)) return true;

  const ref = simpleColumnRef(castless);
  if (ref && options.isNonNullColumn?.(ref) === true) return true;

  const args = callArgs(castless, "coalesce");
  if (args) {
    return args.some((arg) => isNonNullExpression(arg, nextOptions));
  }

  const call = anyCall(castless);
  if (call && STRICT_FUNCTIONS.has(call.name)) {
    return call.args.length > 0 && call.args.every((arg) => isNonNullExpression(arg, nextOptions));
  }

  // CASE nullability depends on every branch and condition shape; stay conservative.
  if (/\bcase\b/i.test(castless)) return false;

  const binary = splitTopLevelBinary(castless);
  if (binary) {
    return (
      ["+", "-", "*", "/", "%", "||"].includes(binary.op) &&
      isNonNullExpression(binary.left, nextOptions) &&
      isNonNullExpression(binary.right, nextOptions)
    );
  }

  return false;
}

function isNonNullLiteral(expr: string): boolean {
  const s = stripOuterCasts(stripOuterParens(expr.trim()));
  if (/^null$/i.test(s)) return false;
  if (/^(true|false)$/i.test(s)) return true;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return true;
  if (/^'(?:''|[^'])*'$/.test(s)) return true;
  return false;
}

function topLevelSelectList(sql: string): string[] | null {
  const select = findTopLevelKeyword(sql, "select", 0);
  if (select < 0) return null;
  const from = findTopLevelKeyword(sql, "from", select + "select".length);
  const end = from < 0 ? sql.length : from;
  return splitTopLevel(sql.slice(select + "select".length, end), ",");
}

function topLevelFromClause(sql: string): string | null {
  const from = findTopLevelKeyword(sql, "from", 0);
  if (from < 0) return null;
  const starts = ["where", "group", "having", "order", "limit", "offset", "union", "intersect"];
  const end = starts
    .map((kw) => findTopLevelKeyword(sql, kw, from + "from".length))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  return sql.slice(from, end ?? sql.length);
}

function stripAlias(item: string): string {
  const s = item.trim();
  const asIdx = findLastTopLevelKeyword(s, "as");
  if (asIdx >= 0) return s.slice(0, asIdx).trim();

  const parts = splitTopLevelWhitespace(s);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    if (/^"?[A-Za-z_]\w*"?$/.test(last)) return s.slice(0, s.length - last.length).trim();
  }
  return s;
}

function callArgs(expr: string, name: string): string[] | null {
  const s = expr.trim();
  if (!s.toLowerCase().startsWith(name.toLowerCase())) return null;
  let i = name.length;
  while (/\s/.test(s[i] ?? "")) i++;
  if (s[i] !== "(" || matchingParen(s, i) !== s.length - 1) return null;
  return splitTopLevel(s.slice(i + 1, -1), ",");
}

function anyCall(expr: string): { name: string; args: string[] } | null {
  const s = expr.trim();
  const m = /^([A-Za-z_]\w*)/.exec(s);
  if (!m) return null;
  let i = m[1].length;
  while (/\s/.test(s[i] ?? "")) i++;
  if (s[i] !== "(" || matchingParen(s, i) !== s.length - 1) return null;
  return { name: m[1].toLowerCase(), args: splitTopLevel(s.slice(i + 1, -1), ",") };
}

function splitTopLevelBinary(expr: string): { left: string; op: string; right: string } | null {
  const ops = ["||", "+", "-", "*", "/", "%"];
  const matches: { i: number; op: string }[] = [];
  forEachTopLevelChar(expr, (i) => {
    if (matches.length) return;
    for (const op of ops) {
      if (expr.slice(i, i + op.length) === op) {
        // Avoid treating leading signs as binary operators.
        if ((op === "+" || op === "-") && expr.slice(0, i).trim() === "") continue;
        matches.push({ i, op });
        return;
      }
    }
  });
  const found = matches[0];
  if (!found) return null;
  const left = expr.slice(0, found.i).trim();
  const right = expr.slice(found.i + found.op.length).trim();
  return left && right ? { left, op: found.op, right } : null;
}

function stripOuterParens(expr: string): string {
  let s = expr.trim();
  while (s.startsWith("(") && matchingParen(s, 0) === s.length - 1) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function stripOuterCasts(expr: string): string {
  let s = expr.trim();
  while (true) {
    const idx = findTopLevelCast(s);
    if (idx < 0) return s;
    s = s.slice(0, idx).trim();
  }
}

function findTopLevelCast(s: string): number {
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  let depth = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i]!;
    const n = s[i + 1]!;
    if (state === "line") {
      if (c === "\n") state = "normal";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "normal";
        i++;
      }
      continue;
    }
    if (state === "single") {
      if (c === "'" && n === "'") i++;
      else if (c === "'") state = "normal";
      continue;
    }
    if (state === "double") {
      if (c === '"' && n === '"') i++;
      else if (c === '"') state = "normal";
      continue;
    }

    if (c === "-" && n === "-") {
      state = "line";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      i++;
      continue;
    }
    if (c === "'") state = "single";
    else if (c === '"') state = "double";
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ":" && n === ":" && depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  forEachTopLevelChar(s, (i, c) => {
    if (c === sep) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  });
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

function splitTopLevelWhitespace(s: string): string[] {
  const parts: string[] = [];
  let start = 0;
  forEachTopLevelChar(s, (i, c) => {
    if (/\s/.test(c)) {
      const part = s.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  });
  const last = s.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function stripStringsAndComments(s: string): string {
  let out = "";
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const n = s[i + 1] ?? "";
    if (state === "line") {
      if (c === "\n") {
        state = "normal";
        out += c;
      } else out += " ";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "normal";
        out += "  ";
        i++;
      } else out += " ";
      continue;
    }
    if (state === "single") {
      if (c === "'" && n === "'") {
        out += "  ";
        i++;
      } else if (c === "'") {
        state = "normal";
        out += " ";
      } else out += " ";
      continue;
    }

    if (c === "-" && n === "-") {
      state = "line";
      out += "  ";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      out += "  ";
      i++;
      continue;
    }
    if (c === "'") {
      state = "single";
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

function findTopLevelKeyword(sql: string, keyword: string, start: number): number {
  let found = -1;
  forEachTopLevelChar(sql, (i) => {
    if (found >= 0 || i < start) return;
    if (keywordAt(sql, i, keyword)) found = i;
  });
  return found;
}

function findLastTopLevelKeyword(sql: string, keyword: string): number {
  let found = -1;
  forEachTopLevelChar(sql, (i) => {
    if (keywordAt(sql, i, keyword)) found = i;
  });
  return found;
}

function keywordAt(sql: string, i: number, keyword: string): boolean {
  const before = sql[i - 1] ?? "";
  const after = sql[i + keyword.length] ?? "";
  return (
    !/[A-Za-z0-9_$]/.test(before) &&
    sql.slice(i, i + keyword.length).toLowerCase() === keyword &&
    !/[A-Za-z0-9_$]/.test(after)
  );
}

function normalizeRelationName(name: string): string {
  return name.split(".").map(unquoteIdent).join(".");
}

function unquoteIdent(ident: string): string {
  const s = ident.trim();
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s;
}

function matchingParen(s: string, open: number): number {
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    const n = s[i + 1] ?? "";
    if (state === "line") {
      if (c === "\n") state = "normal";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "normal";
        i++;
      }
      continue;
    }
    if (state === "single") {
      if (c === "'" && n === "'") i++;
      else if (c === "'") state = "normal";
      continue;
    }
    if (state === "double") {
      if (c === '"' && n === '"') i++;
      else if (c === '"') state = "normal";
      continue;
    }

    if (c === "-" && n === "-") {
      state = "line";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      i++;
      continue;
    }
    if (c === "'") state = "single";
    else if (c === '"') state = "double";
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function forEachTopLevelChar(s: string, fn: (i: number, c: string) => void): void {
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const n = s[i + 1] ?? "";
    if (state === "line") {
      if (c === "\n") state = "normal";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "normal";
        i++;
      }
      continue;
    }
    if (state === "single") {
      if (c === "'" && n === "'") i++;
      else if (c === "'") state = "normal";
      continue;
    }
    if (state === "double") {
      if (c === '"' && n === '"') i++;
      else if (c === '"') state = "normal";
      continue;
    }

    if (c === "-" && n === "-") {
      state = "line";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      i++;
      continue;
    }
    if (c === "'") {
      state = "single";
      continue;
    }
    if (c === '"') {
      state = "double";
      continue;
    }

    if (depth === 0) fn(i, c);
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
}
