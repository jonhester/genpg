/** Programmatic API for genpg. */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, resolveConfig, type ResolvedConfig, type GenpgConfig } from "./config.ts";
import { parseQueryFile, type ParsedQuery } from "./sqlfile.ts";
import { loadMigrationsUp } from "./migrations.ts";
import { PgEngine } from "./engine.ts";
import { analyzeQueries } from "./introspect.ts";
import { generateModule } from "./codegen.ts";
import type { AnalyzedQuery } from "./model.ts";
import type { TypeInfo } from "./typemap.ts";

export type { GenpgConfig, ResolvedConfig, OverrideValue } from "./config.ts";
export type { ParsedQuery, QueryCommand } from "./sqlfile.ts";
export type { RewrittenQuery } from "./params.ts";
export type { AnalyzedQuery, QueryColumn, QueryShape } from "./model.ts";
export type { Queryable, QueryResultLike } from "./runtime.ts";
export type { IntrospectionEngine } from "./engine.ts";
export { PgEngine } from "./engine.ts";
export { parseQueryFile } from "./sqlfile.ts";
export { rewriteNamedParams } from "./params.ts";
export { generateModule } from "./codegen.ts";
export { loadMigrationsUp } from "./migrations.ts";

export interface GenerateResult {
  /** The generated TypeScript source. */
  code: string;
  /** Number of queries successfully generated. */
  count: number;
  /** Queries that failed introspection. */
  errors: { name: string; error: string }[];
  /** Non-fatal advisories (e.g. an override that will break at runtime). */
  warnings: string[];
}

/** Run the full pipeline for a resolved config and write the output file. */
export async function generate(config: ResolvedConfig): Promise<GenerateResult> {
  const queries: ParsedQuery[] = [];
  for (const file of config.queryFiles) {
    const content = await readFile(file, "utf8");
    queries.push(...parseQueryFile(content, file));
  }

  const schema = await resolveSchema(config);
  const engine = await PgEngine.create(config.connection);

  try {
    const { analyzed, typeInfo, notNull, errors } = await analyzeQueries({
      engine,
      queries,
      schema,
    });

    const code = generateModule(analyzed, {
      typeInfo,
      notNull,
      overrides: config.typeOverrides,
      imports: config.imports,
      parsers: config.typeParsers,
      serializers: config.typeSerializers,
      runtime: config.typeRuntime,
    });
    await mkdir(dirname(config.out), { recursive: true });
    await writeFile(config.out, code, "utf8");

    const warnings = collectOverrideWarnings(analyzed, typeInfo, config);
    return { code, count: analyzed.length, errors, warnings };
  } finally {
    await engine.dispose();
  }
}

/**
 * Flag overrides that will break at runtime: a custom type used in a position
 * (result/param) without the converter that makes the runtime value match. Types
 * declared `runtime: "none"` are intentional and skipped.
 */
function collectOverrideWarnings(
  analyzed: AnalyzedQuery[],
  typeInfo: TypeInfo,
  config: ResolvedConfig,
): string[] {
  const usedAsResult = new Set<string>();
  const usedAsParam = new Set<string>();
  const names = (oid: number): string[] => {
    const t = typeInfo.types.get(oid);
    if (!t) return [];
    const out = [t.name];
    if (t.typcategory === "A" && t.typelem) {
      const el = typeInfo.types.get(t.typelem);
      if (el) out.push(el.name);
    }
    return out;
  };

  for (const a of analyzed) {
    if (a.query.command === "one" || a.query.command === "many") {
      for (const col of a.shape.columns ?? [])
        for (const n of names(col.typeOid)) usedAsResult.add(n);
    }
    for (const p of a.rewritten.params) {
      for (const ph of p.placeholders) {
        for (const n of names(a.shape.params[ph - 1] ?? 0)) usedAsParam.add(n);
      }
    }
  }

  const warnings: string[] = [];
  for (const [name, tsType] of config.typeOverrides) {
    const runtime =
      config.typeRuntime.get(name) ??
      (config.typeParsers.has(name) || config.typeSerializers.has(name) ? "hydrate" : undefined);
    if (runtime === "none") continue;

    if (usedAsResult.has(name) && !config.typeParsers.has(name)) {
      warnings.push(
        `override "${name}" -> ${tsType} is used in results but has no \`parse\`; ` +
          `values stay the driver's default type at runtime, not ${tsType}. ` +
          `Add \`parse\`, or set \`runtime: "none"\` if this is intentional.`,
      );
    }
    if (usedAsParam.has(name) && !config.typeSerializers.has(name)) {
      warnings.push(
        `override "${name}" -> ${tsType} is used as a parameter but has no \`serialize\`; ` +
          `passing a ${tsType} will likely fail at runtime. ` +
          `Add \`serialize\`, or set \`runtime: "none"\` if this is intentional.`,
      );
    }
  }
  return warnings;
}

async function resolveSchema(config: ResolvedConfig): Promise<string | undefined> {
  if (config.schemaFile) return readFile(config.schemaFile, "utf8");
  if (config.migrationsDir) return loadMigrationsUp(config.migrationsDir);
  return undefined;
}

/** Convenience: load a config file from disk and run {@link generate}. */
export async function generateFromConfigFile(configPath: string): Promise<GenerateResult> {
  return generate(await loadConfig(configPath));
}

/** Convenience: run from an in-memory config object. */
export async function generateFromConfig(
  raw: GenpgConfig,
  baseDir = process.cwd(),
): Promise<GenerateResult> {
  return generate(await resolveConfig(raw, baseDir));
}
