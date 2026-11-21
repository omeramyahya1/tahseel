import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.url(),
  API_PORT: z.coerce.number().int().positive().default(3000),
});

export const env = Env.parse(process.env);
