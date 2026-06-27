/**
 * PostgreSQL type OID -> TypeScript type mapping.
 *
 * Two layers:
 *  1. A built-in table of common scalar OIDs (stable, never change).
 *  2. Catalog-driven resolution for everything else (arrays, enums, domains,
 *     user types) using a snapshot of `pg_type` / `pg_enum` loaded at codegen
 *     time. This lets us resolve types created by the user's schema.
 *
 * The chosen TS types mirror how `node-postgres` deserializes values by default:
 *   - int8 / numeric -> string  (pg returns these as strings to avoid precision loss)
 *   - timestamp[tz] / date      -> Date
 *   - json / jsonb              -> unknown (shape is not known statically)
 *   - bytea                     -> Buffer
 */

export interface PgTypeRow {
  oid: number;
  name: string;
  /** pg_type.typtype: 'b' base, 'e' enum, 'd' domain, 'c' composite, ... */
  typtype: string;
  /** pg_type.typcategory: 'A' = array. */
  typcategory: string;
  /** Element type OID for arrays. */
  typelem: number;
  /** Base type OID for domains. */
  typbasetype: number;
}

export interface TypeInfo {
  /** All rows of pg_type, keyed by oid. */
  types: Map<number, PgTypeRow>;
  /** Enum labels keyed by the enum type's oid, in sort order. */
  enums: Map<number, string[]>;
}

export function emptyTypeInfo(): TypeInfo {
  return { types: new Map(), enums: new Map() };
}

/** Built-in scalar OIDs. Source: PostgreSQL `pg_type.dat` (these are fixed). */
const BUILTIN: Record<number, string> = {
  16: "boolean", // bool
  17: "Buffer", // bytea
  18: "string", // char
  19: "string", // name
  20: "string", // int8 (bigint) -> string by default in pg
  21: "number", // int2
  23: "number", // int4
  26: "number", // oid
  25: "string", // text
  114: "unknown", // json
  142: "string", // xml
  650: "string", // cidr
  700: "number", // float4
  701: "number", // float8
  790: "string", // money
  829: "string", // macaddr
  869: "string", // inet
  1042: "string", // bpchar
  1043: "string", // varchar
  1082: "Date", // date
  1083: "string", // time
  1114: "Date", // timestamp
  1184: "Date", // timestamptz
  1186: "string", // interval
  1266: "string", // timetz
  1700: "string", // numeric -> string by default in pg
  2950: "string", // uuid
  3802: "unknown", // jsonb
};

/** User-supplied overrides keyed by Postgres type name (e.g. `timestamptz`). */
export type TypeOverrides = ReadonlyMap<string, string>;

const NO_OVERRIDES: TypeOverrides = new Map();

/**
 * Map a single type OID to a TS type string, resolving via the catalog snapshot.
 * Name-based overrides take precedence and apply recursively (so an override on
 * `timestamptz` also affects `timestamptz[]`, domains over it, etc.).
 */
export function tsForOid(
  oid: number,
  info: TypeInfo,
  overrides: TypeOverrides = NO_OVERRIDES,
  depth = 0,
): string {
  if (oid === 0) return "unknown";
  if (depth > 16) return "unknown"; // cycle guard (shouldn't happen)

  const t = info.types.get(oid);

  // Override by Postgres type name wins over everything else.
  if (t) {
    const override = overrides.get(t.name);
    if (override) return override;
  }

  const builtin = BUILTIN[oid];
  if (builtin) return builtin;

  if (!t) return "unknown";

  // Domain: resolve to the underlying base type.
  if (t.typtype === "d" && t.typbasetype) {
    return tsForOid(t.typbasetype, info, overrides, depth + 1);
  }

  // Array: element type followed by `[]`.
  if (t.typcategory === "A" && t.typelem) {
    const elem = tsForOid(t.typelem, info, overrides, depth + 1);
    return /[|&]/.test(elem) ? `(${elem})[]` : `${elem}[]`;
  }

  // Enum: union of string literals.
  if (t.typtype === "e") {
    const labels = info.enums.get(oid);
    if (labels && labels.length > 0) {
      return labels.map((l) => JSON.stringify(l)).join(" | ");
    }
    return "string";
  }

  return "unknown";
}

/** Stable key for a (table oid, column attnum) pair used by the nullability map. */
export function attrKey(tableOid: number, columnAttr: number): string {
  return `${tableOid}:${columnAttr}`;
}
