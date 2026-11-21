import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/db";
import { newId } from "../../lib/ids";
import { createSimulatedRail, SIMULATED_ALIASES } from "..";

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.drop();
});

function request(debtorAlias: string, expiresInMs: number) {
  return {
    attemptId: newId(),
    livemode: false,
    amount: 100n,
    currency: "SDG",
    creditor: { name: "Shop", bankCode: "TESTBANK", account: "1" },
    debtorAlias,
    expiresAt: new Date(Date.now() + expiresInMs),
    remittanceInfo: null,
  };
}

async function scheduled(attemptId: string) {
  const [job] = await t.sql`
    select payload->>'outcome' as outcome,
           (extract(epoch from run_at) * 1000)::float8 as run_at_ms
    from jobs where payload->>'attemptId' = ${attemptId}`;
  return job as { outcome: string; run_at_ms: number } | undefined;
}

describe("simulated rail", () => {
  const rail = () => createSimulatedRail({ db: t.db, responseDelayMs: 10_000 });

  test.each([
    ["succeeds", SIMULATED_ALIASES.succeeds],
    ["declines", SIMULATED_ALIASES.declines],
  ])(
    "a response (%s) that would land after expiresAt becomes expired at expiresAt",
    async (_, alias) => {
      const req = request(alias, 1_000); // expires before the 10 s delay
      await rail().requestToPay(req);
      const job = await scheduled(req.attemptId);
      expect(job?.outcome).toBe("expired");
      expect(job?.run_at_ms).toBe(req.expiresAt.getTime());
    },
  );

  test("responses before expiresAt keep their outcome and delay", async () => {
    for (const [alias, outcome] of [
      [SIMULATED_ALIASES.succeeds, "succeeded"],
      [SIMULATED_ALIASES.declines, "declined"],
    ] as const) {
      const req = request(alias, 60_000);
      const before = Date.now();
      await rail().requestToPay(req);
      const job = await scheduled(req.attemptId);
      expect(job?.outcome).toBe(outcome);
      expect(job?.run_at_ms).toBeGreaterThanOrEqual(before + 10_000);
      expect(job?.run_at_ms).toBeLessThan(req.expiresAt.getTime());
    }
  });
});
