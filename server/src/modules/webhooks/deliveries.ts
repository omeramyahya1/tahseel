import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { KeyProvider } from "../../crypto/keys";
import { type Db, withTx } from "../../db/client";
import {
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
} from "../../db/schema";
import { enqueue, type HandlerMap, type Job, RetryLater } from "../../jobs";
import { newId } from "../../lib/ids";
import { DISPATCH_EVENT, getEventById, presentEvent } from "../events";
import { SIGNATURE_HEADER, signWebhook } from "./signature";
import { checkUrlSyntax, checkUrlTarget, type UrlPolicy } from "./url-policy";

export const WEBHOOKS_QUEUE = "webhooks";
export const DELIVER_WEBHOOK = "deliver_webhook";

/**
 * Delay before retry N (1-based): 1 min growing to 12 h, ~2.7 days in total.
 * The first attempt plus these 12 retries = 13 attempts.
 */
export const RETRY_SCHEDULE_SECONDS = [
  60, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800, 43_200, 43_200, 43_200,
  43_200,
] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;

const EXCERPT_BYTES = 1024;

/**
 * Reads at most EXCERPT_BYTES of the response body, then cancels the rest
 * of the stream: a huge or never-ending body must not hold memory or the
 * worker. Returns null when there's no content or reading fails.
 */
async function readExcerpt(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < EXCERPT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks)
    .subarray(0, EXCERPT_BYTES)
    .toString("utf8");
  return text || null;
}

export type WebhookDeps = {
  keys: KeyProvider;
  urlPolicy: UrlPolicy;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

// IDs are ULIDs stored as uuid: not RFC 4122, so use z.guid().
const DispatchPayload = z.object({ eventId: z.guid() });
const DeliverPayload = z.object({ deliveryId: z.guid() });

/**
 * Fans an event out to every subscribed endpoint: one delivery row and one
 * job per endpoint, committed together. Safe to run more than once.
 */
export async function dispatchEvent(db: Db, eventId: string): Promise<number> {
  const event = await getEventById(db, eventId);
  if (!event) throw new Error(`event ${eventId} not found`);

  const endpoints = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.merchantId, event.merchantId),
        eq(webhookEndpoints.livemode, event.livemode),
        isNull(webhookEndpoints.deletedAt),
        sql`(${webhookEndpoints.enabledEvents} @> ARRAY['*']::text[] OR ${webhookEndpoints.enabledEvents} @> ARRAY[${event.type}]::text[])`,
      ),
    );
  if (endpoints.length === 0) return 0;

  await withTx(db, async (tx) => {
    await tx
      .insert(webhookDeliveries)
      .values(
        endpoints.map((e) => ({
          id: newId(),
          eventId: event.id,
          endpointId: e.id,
        })),
      )
      .onConflictDoNothing({
        target: [webhookDeliveries.eventId, webhookDeliveries.endpointId],
      });
    const deliveries = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, event.id));
    for (const d of deliveries) {
      await enqueue(tx, {
        queue: WEBHOOKS_QUEUE,
        kind: DELIVER_WEBHOOK,
        payload: { deliveryId: d.id },
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
        dedupeKey: `${DELIVER_WEBHOOK}:${d.id}`,
      });
    }
  });
  return endpoints.length;
}

async function finish(
  db: Db,
  deliveryId: string,
  status: "succeeded" | "failed",
  error: string | null = null,
) {
  await db
    .update(webhookDeliveries)
    .set({
      status,
      ...(status === "succeeded" ? { succeededAt: new Date() } : {}),
      ...(error ? { lastError: error } : {}),
      updatedAt: new Date(),
    })
    .where(eq(webhookDeliveries.id, deliveryId));
}

/**
 * One delivery attempt. 2xx = success; anything else (including redirects,
 * which are never followed) is retried on RETRY_SCHEDULE_SECONDS until the
 * last attempt, then the delivery is marked failed.
 */
export async function deliverWebhook(
  db: Db,
  deps: WebhookDeps,
  job: Pick<Job, "attempts" | "maxAttempts">,
  deliveryId: string,
): Promise<void> {
  const [row] = await db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookEndpoints.id, webhookDeliveries.endpointId),
    )
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row) throw new Error(`webhook delivery ${deliveryId} not found`);
  const { delivery, endpoint } = row;
  if (delivery.status !== "pending") return;
  if (endpoint.deletedAt) {
    return finish(db, delivery.id, "failed", "endpoint_deleted");
  }

  const event = await getEventById(db, delivery.eventId);
  if (!event) throw new Error(`event ${delivery.eventId} not found`);
  const body = JSON.stringify(presentEvent(event));
  const secret = deps.keys.decrypt(endpoint.secretEncrypted);

  const requestedAt = new Date();
  const started = performance.now();
  let responseStatus: number | null = null;
  let error: string | null = null;
  let excerpt: string | null = null;

  const blocked =
    checkUrlSyntax(endpoint.url, endpoint.livemode) ??
    (await checkUrlTarget(endpoint.url, deps.urlPolicy));
  if (blocked) {
    error = `url_blocked: url ${blocked}`;
  } else {
    try {
      const res = await (deps.fetch ?? fetch)(endpoint.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
        headers: {
          "content-type": "application/json",
          "user-agent": "Tahseel-Webhooks/1.0",
          [SIGNATURE_HEADER]: signWebhook(secret, body),
        },
        body,
      });
      responseStatus = res.status;
      excerpt = await readExcerpt(res);
    } catch (err) {
      error =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  const ok =
    responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
  if (!ok && !error) error = `http_${responseStatus}`;

  await db.insert(webhookDeliveryAttempts).values({
    id: newId(),
    deliveryId: delivery.id,
    attemptNumber: job.attempts,
    requestedAt,
    durationMs: Math.round(performance.now() - started),
    responseStatus,
    error,
    responseExcerpt: excerpt,
  });
  await db
    .update(webhookDeliveries)
    .set({
      attempts: job.attempts,
      lastAttemptAt: requestedAt,
      lastResponseStatus: responseStatus,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(eq(webhookDeliveries.id, delivery.id));

  if (ok) return finish(db, delivery.id, "succeeded");
  if (job.attempts >= job.maxAttempts) {
    return finish(db, delivery.id, "failed", error);
  }
  const delay =
    RETRY_SCHEDULE_SECONDS[job.attempts - 1] ?? RETRY_SCHEDULE_SECONDS.at(-1);
  throw new RetryLater(delay ?? 43_200, error ?? "delivery failed");
}

/** Handler for the `events` queue: fans events out to webhook endpoints. */
export function eventDispatchHandlers(db: Db): HandlerMap {
  return {
    [DISPATCH_EVENT]: async (job) => {
      const { eventId } = DispatchPayload.parse(job.payload);
      await dispatchEvent(db, eventId);
    },
  };
}

/** Handler for the `webhooks` queue. */
export function webhookJobHandlers(db: Db, deps: WebhookDeps): HandlerMap {
  return {
    [DELIVER_WEBHOOK]: async (job) => {
      const { deliveryId } = DeliverPayload.parse(job.payload);
      await deliverWebhook(db, deps, job, deliveryId);
    },
  };
}
