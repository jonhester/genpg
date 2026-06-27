import { expect, test } from "vite-plus/test";
import { Client } from "pg";
import { PgEngine } from "../src/engine.ts";

const connection = process.env.TEST_DATABASE_URL;

test.skipIf(!connection)(
  "describes queries on real PostgreSQL and rolls schema replay back",
  async () => {
    const table = `genpg_engine_test_${process.pid}`;
    const engine = await PgEngine.create(connection!);
    try {
      await engine.applySchema(`
      CREATE TABLE ${table} (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        label text NOT NULL
      );
    `);

      const shape = await engine.describe(
        `INSERT INTO ${table} (label) VALUES ($1) RETURNING id, label`,
      );
      expect(shape.params).toEqual([25]);
      expect(shape.columns?.map((column) => [column.name, column.typeOid])).toEqual([
        ["id", 20],
        ["label", 25],
      ]);

      await expect(engine.describe(`SELECT * FROM ${table} WHERE nope = $1`)).rejects.toThrow();
      expect((await engine.describe(`SELECT id FROM ${table}`)).columns?.[0]?.typeOid).toBe(20);

      const [version] = await engine.queryRows("SHOW server_version_num");
      if (Number(version.server_version_num) >= 180000) {
        const uuidShape = await engine.describe("SELECT uuidv7() AS id");
        expect(uuidShape.columns?.[0]?.typeOid).toBe(2950);
      }
    } finally {
      await engine.dispose();
    }

    const verifier = new Client({ connectionString: connection });
    await verifier.connect();
    try {
      const result = await verifier.query(`SELECT to_regclass($1) AS relation`, [table]);
      expect(result.rows[0]?.relation).toBeNull();
    } finally {
      await verifier.end();
    }
  },
);
