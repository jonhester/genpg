import { expect, test } from "vite-plus/test";
import { resolveConfig } from "../src/config.ts";

test("resolves a real PostgreSQL connection without changing file paths", async () => {
  const config = await resolveConfig(
    {
      connection: "postgres://postgres:postgres@localhost:5432/genpg",
      schema: "db/schema.sql",
      queries: "db/queries.sql",
      out: "src/generated.ts",
    },
    "/project",
  );

  expect(config.connection).toBe("postgres://postgres:postgres@localhost:5432/genpg");
  expect(config.schemaFile).toBe("/project/db/schema.sql");
  expect(config.queryFiles).toEqual(["/project/db/queries.sql"]);
  expect(config.out).toBe("/project/src/generated.ts");
  expect(config.caseStyle).toBe("preserve");
});

test("resolves camel caseStyle", async () => {
  const config = await resolveConfig(
    {
      connection: "postgres://postgres:postgres@localhost:5432/genpg",
      schema: "schema.sql",
      queries: "queries.sql",
      out: "generated.ts",
      caseStyle: "camel",
    },
    "/project",
  );

  expect(config.caseStyle).toBe("camel");
});

test("rejects unknown caseStyle", async () => {
  await expect(
    resolveConfig(
      {
        connection: "postgres://postgres:postgres@localhost:5432/genpg",
        schema: "schema.sql",
        queries: "queries.sql",
        out: "generated.ts",
        caseStyle: "camelCase",
      } as any,
      "/project",
    ),
  ).rejects.toThrow('caseStyle` must be "preserve" or "camel"');
});

test("requires a PostgreSQL connection", async () => {
  await expect(
    resolveConfig(
      {
        schema: "schema.sql",
        queries: "queries.sql",
        out: "generated.ts",
      },
      "/project",
    ),
  ).rejects.toThrow("Set `connection` or the DATABASE_URL environment variable");
});
