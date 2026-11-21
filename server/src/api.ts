import { createEnvKeyProvider } from "./crypto/keys";
import { createDb } from "./db/client";
import { loadEnv } from "./env";
import { createApp } from "./http/app";

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);
const keys = createEnvKeyProvider({
  apiKeyPepper: env.API_KEY_PEPPER,
  secretsEncryptionKey: env.SECRETS_ENCRYPTION_KEY,
});

const app = createApp({ db, keys });

export default {
  port: env.API_PORT,
  fetch: app.fetch,
};
