import { z } from "zod";

const base64Key = (minBytes: number) =>
  z
    .string()
    .refine(
      (v) => Buffer.from(v, "base64").length >= minBytes,
      `must be at least ${minBytes} bytes, base64-encoded`,
    );

const Env = z.object({
  DATABASE_URL: z.url(),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_KEY_PEPPER: base64Key(32),
  SECRETS_ENCRYPTION_KEY: base64Key(32),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  return Env.parse(source);
}
