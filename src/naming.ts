/** Naming helpers for turning query names into identifiers. */

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** "get_user" / "getUser" -> "GetUser" */
export function pascalCase(name: string): string {
  return words(name)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

/** "get_user" / "GetUser" -> "getUser" */
export function camelCase(name: string): string {
  const p = pascalCase(name);
  return p ? p[0].toLowerCase() + p.slice(1) : p;
}
