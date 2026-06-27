/**
 * dbmate-style migration loading.
 *
 * A migrations directory holds `*.sql` files named so they sort chronologically
 * (e.g. `20240101120000_create_users.sql`). Each file looks like:
 *
 *   -- migrate:up
 *   CREATE TABLE users (...);
 *   -- migrate:down
 *   DROP TABLE users;
 *
 * We concatenate every `migrate:up` block in filename order to reconstruct the
 * current schema, with no database dump required. Files without markers are
 * treated as plain schema SQL.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadMigrationsUp(dir: string): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const blocks: string[] = [];
  for (const file of files) {
    const content = await readFile(join(dir, file), "utf8");
    const up = extractUp(content).trim();
    if (up) blocks.push(`-- ${file}\n${up}`);
  }
  return blocks.join("\n\n");
}

/** Extract the `migrate:up` portion of a single migration file. */
export function extractUp(content: string): string {
  if (!/--\s*migrate:up\b/.test(content)) {
    return content; // plain schema file, no markers
  }
  const out: string[] = [];
  let capturing = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*--\s*migrate:up\b/.test(line)) {
      capturing = true;
      continue;
    }
    if (/^\s*--\s*migrate:down\b/.test(line)) {
      capturing = false;
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join("\n");
}
