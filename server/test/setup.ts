import { afterAll } from "bun:test";
import { dropTemplateDb, prepareTemplateDb } from "./db";

await prepareTemplateDb();

// Hooks in a preload file run once for the whole run.
afterAll(dropTemplateDb);
