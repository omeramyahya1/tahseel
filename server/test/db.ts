import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "../src/db/client";

// Each test file gets a fresh database cloned from a migrated template.
// Rollback-based isolation is not an option: the ledger's deferred
// constraint triggers only fire at COMMIT.

// Unique per test run, so concurrent `bun test` runs never drop, migrate or
// clone each other's template. Set once by the preload (test/setup.ts) via
// the environment, so every importer in this run agrees on the name.
process.env.TAHSEEL_TEST_TEMPLATE ??= `tahseel_test_template_${randomBytes(6).toString("hex")}`;
const TEMPLATE = process.env.TAHSEEL_TEST_TEMPLATE;
const MIGRATIONS = path.join(import.meta.dir, "..", "migrations");

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://tahseel:tahseel@localhost:5432/postgres";

function urlFor(database: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function admin() {
  return postgres(adminUrl, { max: 1, onnotice: () => {} });
}

export async function prepareTemplateDb() {
  const sql = admin();
  try {
    await sql.unsafe(`CREATE DATABASE ${TEMPLATE}`);
  } finally {
    await sql.end();
  }

  if (!existsSync(path.join(MIGRATIONS, "meta", "_journal.json"))) return;

  const { sql: tsql, db } = createDb(urlFor(TEMPLATE), { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS });
  } finally {
    await tsql.end();
  }
}

export async function dropTemplateDb() {
  const sql = admin();
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
  } finally {
    await sql.end();
  }
}

export async function createTestDb() {
  const name = `tahseel_test_${randomBytes(6).toString("hex")}`;
  const sql = admin();
  try {
    await sql.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  } finally {
    await sql.end();
  }

  const conn = createDb(urlFor(name));
  return {
    ...conn,
    async drop() {
      await conn.sql.end();
      const a = admin();
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
