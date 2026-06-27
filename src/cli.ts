#!/usr/bin/env node
/** genpg command-line interface. */

import { loadConfig } from "./config.ts";
import { generate } from "./index.ts";

const USAGE = `genpg - generate type-safe TypeScript from SQL for PostgreSQL

Usage:
  genpg generate [--config <path>] [--verbose]   Generate the output file (default command)
  genpg --help                                  Show this help

Options:
  -c, --config <path>   Path to config file (default: genpg.json)
  -v, --verbose         Print progress/debug output to stderr

Config (JSON):
  {
    "connection": "postgres://user:pass@localhost:5432/db",  // or set DATABASE_URL
    "schema": "schema.sql",                                  // optional
    "queries": "src/queries/**/*.sql",
    "out": "src/db/queries.ts"
  }
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  let configPath = "genpg.json";
  let verbose = process.env.GENPG_VERBOSE === "1" || process.env.GENPG_DEBUG === "1";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config" || a === "-c") {
      configPath = args[++i] ?? configPath;
    } else if (a.startsWith("--config=")) {
      configPath = a.slice("--config=".length);
    } else if (a === "--verbose" || a === "-v" || a === "--debug") {
      verbose = true;
    } else {
      positional.push(a);
    }
  }

  const command = positional[0] ?? "generate";
  if (command !== "generate") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  const start = Date.now();
  const progress = verbose
    ? (message: string) => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        process.stderr.write(`[genpg +${elapsed}s] ${message}\n`);
      }
    : undefined;

  progress?.(`loading config ${configPath}`);
  const config = await loadConfig(configPath);
  const result = await generate(config, { progress });

  process.stdout.write(
    `Generated ${result.count} quer${result.count === 1 ? "y" : "ies"} -> ${config.out}\n`,
  );
  if (result.warnings.length > 0) {
    process.stderr.write(`\n${result.warnings.length} warning(s):\n`);
    for (const w of result.warnings) {
      process.stderr.write(`  ! ${w}\n`);
    }
  }
  if (result.errors.length > 0) {
    process.stderr.write(`\n${result.errors.length} query(ies) failed to analyze:\n`);
    for (const e of result.errors) {
      process.stderr.write(`  - ${e.name}: ${e.error}\n`);
    }
    return 1;
  }
  return 0;
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Error: ${err?.message ?? err}\n`);
    process.exit(1);
  });
