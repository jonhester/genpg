#!/usr/bin/env node
/** genpg command-line interface. */

import { loadConfig } from "./config.ts";
import { generate } from "./index.ts";

const USAGE = `genpg - generate type-safe TypeScript from SQL for PostgreSQL

Usage:
  genpg generate [--config <path>]   Generate the output file (default command)
  genpg --help                       Show this help

Options:
  -c, --config <path>   Path to config file (default: genpg.json)

Config (JSON):
  {
    "connection": "postgres://user:pass@localhost:5432/db",  // or DATABASE_URL
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
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config" || a === "-c") {
      configPath = args[++i] ?? configPath;
    } else if (a.startsWith("--config=")) {
      configPath = a.slice("--config=".length);
    } else {
      positional.push(a);
    }
  }

  const command = positional[0] ?? "generate";
  if (command !== "generate") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  const config = await loadConfig(configPath);
  const result = await generate(config);

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
