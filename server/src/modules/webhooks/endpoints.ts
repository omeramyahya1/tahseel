import { and, count, desc, eq, isNull, lt } from "drizzle-orm";
import type { KeyProvider } from "../../crypto/keys";
import type { DbOrTx } from "../../db/client";
import { webhookEndpoints } from "../../db/schema";
import { newId, toPublicId } from "../../lib/ids";
import { WebhookError } from "./errors";
import { generateWebhookSecret } from "./signature";
import { checkUrlSyntax, checkUrlTarget, type UrlPolicy } from "./url-policy";

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
type Scope = { merchantId: string; livemode: boolean };

export const MAX_ENDPOINTS_PER_MODE = 16;

export function presentWebhookEndpoint(endpoint: WebhookEndpoint) {
  return {
    id: toPublicId("we", endpoint.id),
    object: "webhook_endpoint" as const,
    livemode: endpoint.livemode,
    url: endpoint.url,
    description: endpoint.description,
    enabled_events: endpoint.enabledEvents,
    created_at: endpoint.createdAt.toISOString(),
  };
}

const active = (scope: Scope) =>
  and(
    eq(webhookEndpoints.merchantId, scope.merchantId),
    eq(webhookEndpoints.livemode, scope.livemode),
    isNull(webhookEndpoints.deletedAt),
  );

/** Creates an endpoint. The signing secret is returned once. */
export async function createWebhookEndpoint(
  db: DbOrTx,
  deps: { keys: KeyProvider; urlPolicy: UrlPolicy },
  input: Scope & {
    url: string;
    description?: string | null;
    enabledEvents: string[];
  },
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const problem =
    checkUrlSyntax(input.url, input.livemode) ??
    (await checkUrlTarget(input.url, deps.urlPolicy));
  if (problem) throw new WebhookError("url_invalid", `url ${problem}.`, "url");

  const [existing] = await db
    .select({ n: count() })
    .from(webhookEndpoints)
    .where(active(input));
  if ((existing?.n ?? 0) >= MAX_ENDPOINTS_PER_MODE) {
    throw new WebhookError(
      "too_many_webhook_endpoints",
      `At most ${MAX_ENDPOINTS_PER_MODE} webhook endpoints per mode.`,
    );
  }

  const secret = generateWebhookSecret();
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      id: newId(),
      merchantId: input.merchantId,
      livemode: input.livemode,
      url: input.url,
      description: input.description ?? null,
      enabledEvents: [...new Set(input.enabledEvents)],
      secretEncrypted: deps.keys.encrypt(secret),
    })
    .returning();
  if (!endpoint) throw new Error("failed to create webhook endpoint");
  return { endpoint, secret };
}

export async function getWebhookEndpoint(
  db: DbOrTx,
  scope: Scope,
  id: string,
): Promise<WebhookEndpoint | null> {
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), active(scope)));
  return endpoint ?? null;
}

export async function listWebhookEndpoints(
  db: DbOrTx,
  scope: Scope,
  options: { limit: number; startingAfter?: string },
): Promise<{ data: WebhookEndpoint[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        active(scope),
        options.startingAfter
          ? lt(webhookEndpoints.id, options.startingAfter)
          : undefined,
      ),
    )
    .orderBy(desc(webhookEndpoints.id))
    .limit(options.limit + 1);
  return {
    data: rows.slice(0, options.limit),
    hasMore: rows.length > options.limit,
  };
}

/** Soft-deletes: pending deliveries to it stop at their next attempt. */
export async function deleteWebhookEndpoint(
  db: DbOrTx,
  scope: Scope,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(webhookEndpoints)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(webhookEndpoints.id, id), active(scope)))
    .returning({ id: webhookEndpoints.id });
  return rows.length > 0;
}
