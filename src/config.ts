/** Configuration loading and resolution. */

import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface GenpgConfig {
  /** Dedicated PostgreSQL connection URL. The CLI also accepts DATABASE_URL. */
  connection?: string;
  /** Path to a schema .sql file. Mutually exclusive with `migrations`. */
  schema?: string;
  /** Path to a dbmate-style migrations directory. Mutually exclusive with `schema`. */
  migrations?: string;
  /** Glob pattern(s) or file path(s) for annotated query files. */
  queries: string | string[];
  /** Output .ts file path. */
  out: string;
  /**
   * Map Postgres type names to custom TypeScript types, e.g.
   * `{ "timestamptz": "Temporal.Instant" }`. The object form additionally allows:
   *  - `import`: line(s) emitted at the top of the output file.
   *  - `parse`: a `(value) => T` expression converting the driver's value into `T`.
   *    genpg hydrates result columns of this type per row so they are `T` at runtime.
   *  - `serialize`: a `(value: T) => unknown` expression converting `T` back into a
   *    value the driver accepts when it is passed as a query parameter.
   *  - `runtime`: `"hydrate"` (default when parse/serialize is set) generates the
   *    conversions; `"none"` suppresses them and the safety warnings (use for
   *    structural aliases like branded strings, or when you wire the driver yourself).
   */
  overrides?: Record<string, OverrideValue>;
}

export type OverrideRuntime = "hydrate" | "none";

export type OverrideValue =
  | string
  | {
      type: string;
      import?: string | string[];
      parse?: string;
      serialize?: string;
      runtime?: OverrideRuntime;
    };

export interface ResolvedConfig {
  connection: string;
  schemaFile?: string;
  migrationsDir?: string;
  queryFiles: string[];
  out: string;
  /** Postgres type name -> TS type. */
  typeOverrides: Map<string, string>;
  /** De-duplicated import lines to emit in the generated file. */
  imports: string[];
  /** Postgres type name -> `(value) => T` expression for result hydration. */
  typeParsers: Map<string, string>;
  /** Postgres type name -> `(value: T) => unknown` expression for param serialization. */
  typeSerializers: Map<string, string>;
  /** Postgres type name -> explicit runtime mode (`hydrate`/`none`). */
  typeRuntime: Map<string, OverrideRuntime>;
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const abs = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  let raw: GenpgConfig;
  try {
    raw = JSON.parse(await readFile(abs, "utf8"));
  } catch (e: any) {
    throw new Error(`Failed to read config "${abs}": ${e?.message ?? e}`);
  }
  if (!raw.connection && process.env.DATABASE_URL) {
    raw.connection = process.env.DATABASE_URL;
  }
  return resolveConfig(raw, dirname(abs));
}

export async function resolveConfig(raw: GenpgConfig, baseDir: string): Promise<ResolvedConfig> {
  if (!raw.queries) throw new Error("Config is missing `queries`.");
  if (!raw.out) throw new Error("Config is missing `out`.");
  if (!raw.connection) {
    throw new Error(
      "Config needs PostgreSQL. Set `connection` or the DATABASE_URL environment variable.",
    );
  }
  if (raw.schema && raw.migrations) {
    throw new Error("Specify only one of `schema` or `migrations`.");
  }

  const schemaFile = raw.schema ? resolve(baseDir, raw.schema) : undefined;
  const migrationsDir = raw.migrations ? resolve(baseDir, raw.migrations) : undefined;
  if (!schemaFile && !migrationsDir) {
    throw new Error("Config needs the schema to build from. Set `schema` or `migrations`.");
  }

  const patterns = Array.isArray(raw.queries) ? raw.queries : [raw.queries];
  const queryFiles = await expandQueries(patterns, baseDir);
  if (queryFiles.length === 0) {
    throw new Error(`No query files matched: ${patterns.join(", ")}`);
  }

  return {
    connection: raw.connection,
    schemaFile,
    migrationsDir,
    queryFiles,
    out: resolve(baseDir, raw.out),
    ...resolveOverrides(raw.overrides),
  };
}

function resolveOverrides(raw?: Record<string, OverrideValue>): {
  typeOverrides: Map<string, string>;
  imports: string[];
  typeParsers: Map<string, string>;
  typeSerializers: Map<string, string>;
  typeRuntime: Map<string, OverrideRuntime>;
} {
  const typeOverrides = new Map<string, string>();
  const typeParsers = new Map<string, string>();
  const typeSerializers = new Map<string, string>();
  const typeRuntime = new Map<string, OverrideRuntime>();
  const imports = new Set<string>();
  for (const [dbType, value] of Object.entries(raw ?? {})) {
    if (typeof value === "string") {
      typeOverrides.set(dbType, value);
    } else {
      typeOverrides.set(dbType, value.type);
      if (value.parse) typeParsers.set(dbType, value.parse);
      if (value.serialize) typeSerializers.set(dbType, value.serialize);
      if (value.runtime) typeRuntime.set(dbType, value.runtime);
      const imp = value.import;
      if (Array.isArray(imp)) for (const line of imp) imports.add(line);
      else if (imp) imports.add(imp);
    }
  }
  return { typeOverrides, imports: [...imports], typeParsers, typeSerializers, typeRuntime };
}

async function expandQueries(patterns: string[], baseDir: string): Promise<string[]> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    let matched = false;
    try {
      for await (const entry of glob(pattern, { cwd: baseDir })) {
        found.add(resolve(baseDir, entry));
        matched = true;
      }
    } catch {
      // Fall through to literal-path handling below.
    }
    if (!matched) {
      found.add(resolve(baseDir, pattern));
    }
  }
  return [...found].sort();
}
