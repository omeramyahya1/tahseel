import { createMiddleware } from "hono/factory";
import type { KeyProvider } from "../crypto/keys";
import type { Db } from "../db/client";
import {
  type ApiKey,
  authenticateApiKey,
  type Merchant,
} from "../modules/merchants";
import { ApiError } from "./errors";

export type AuthVariables = {
  merchant: Merchant;
  apiKey: ApiKey;
  livemode: boolean;
};

/**
 * Bearer secret-key auth. Every downstream query must scope by
 * (c.var.merchant.id, c.var.livemode).
 */
export function requireApiKey(deps: { db: Db; keys: KeyProvider }) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const header = c.req.header("authorization");
    const secret = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : undefined;
    if (!secret) {
      throw new ApiError(
        401,
        "authentication_error",
        "api_key_missing",
        "Provide your secret key as `Authorization: Bearer sk_...`.",
      );
    }

    const result = await authenticateApiKey(deps.db, deps.keys, secret);
    if (!result.ok) {
      if (result.reason === "merchant_suspended") {
        throw new ApiError(
          403,
          "permission_error",
          "merchant_suspended",
          "This merchant account is suspended.",
        );
      }
      throw new ApiError(
        401,
        "authentication_error",
        result.reason === "revoked" ? "api_key_revoked" : "api_key_invalid",
        result.reason === "revoked"
          ? "This API key has been revoked."
          : "Invalid API key.",
      );
    }

    c.set("merchant", result.merchant);
    c.set("apiKey", result.apiKey);
    c.set("livemode", result.livemode);
    await next();
  });
}
