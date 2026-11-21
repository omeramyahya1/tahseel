import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDb(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { sql, db };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// SQLSTATEs that are safe to retry: serialization_failure, deadlock_detected.
const RETRYABLE = new Set(["40001", "40P01"]);

export function pgErrorCode(err: unknown): string | undefined {
  let e: unknown = err;
  // Drizzle wraps driver errors; walk the cause chain.
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export type TxOptions = {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  maxAttempts?: number;
};

export async function withTx<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  let delay = 50;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(fn, {
        isolationLevel: options.isolationLevel ?? "read committed",
      });
    } catch (err) {
      const code = pgErrorCode(err);
      if (!code || !RETRYABLE.has(code) || attempt >= maxAttempts) throw err;
      await sleep(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 1000);
    }
  }
}
