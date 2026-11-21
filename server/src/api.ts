import { loadEnv } from "./env";
import { createApp } from "./http/app";
import { createRuntime } from "./runtime";

const env = loadEnv();
const { db, keys, payments, webhooks } = createRuntime(env);

const app = createApp({ db, keys, payments, webhooks });

export default {
  port: env.API_PORT,
  fetch: app.fetch,
};
