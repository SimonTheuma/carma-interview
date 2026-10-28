import { describe, expect, it, vi } from "vitest";
import { finishSentiment } from "@/worker/finish";
import type pg from "pg";

function mockClient(
  handlers: Array<(sql: string, params: unknown[]) => { rowCount?: number; rows?: unknown[] }>,
) {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const h = handlers[i++];
      if (!h) throw new Error(`unexpected query #${i}: ${sql.slice(0, 80)}`);
      return h(sql, params);
    }),
  } as unknown as pg.PoolClient;
}

describe("finishSentiment claim-first", () => {
  it("releases budget and skips inserts when claim is lost", async () => {
    const client = mockClient([
      (sql) => {
        expect(sql).toMatch(/pg_advisory_xact_lock/);
        return { rowCount: 1, rows: [] };
      },
      () => ({ rowCount: 1, rows: [{ version: 1 }] }),
      (sql) => {
        expect(sql).toMatch(/UPDATE enrichment_jobs/);
        return { rowCount: 0, rows: [] };
      },
      (sql) => {
        expect(sql).toMatch(/llm_budget_ledger/);
        expect(sql).toMatch(/reserved_micro/);
        return { rowCount: 1, rows: [] };
      },
    ]);

    const ok = await finishSentiment(client, {
      jobId: "1",
      articleId: "2",
      articleVersion: 1,
      workerId: "w1",
      promptVersion: "v1",
      inputHash: Buffer.alloc(32),
      truncated: false,
      trust: "normal",
      costMicro: 100,
      reservedMicro: 10000,
      providerBudgetKey: "jev",
      dayUtc: "2026-07-14",
      result: {
        value: { choice: "neutral", confidence: 0.5 },
        raw: {},
        usage: {},
        model: "m",
        origin: "mock",
      },
    });

    expect(ok).toBe(false);
    expect((client.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    const allSql = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(allSql.some((s) => s.includes("INSERT INTO enrichments"))).toBe(false);
  });

  it("inserts enrichments only after a successful claim update", async () => {
    const client = mockClient([
      () => ({ rowCount: 1, rows: [] }), // advisory lock
      () => ({ rowCount: 1, rows: [{ version: 1 }] }), // version check
      () => ({ rowCount: 1, rows: [] }), // claim
      () => ({ rowCount: 1, rows: [{ id: "9" }] }), // enrichment
      (sql) => {
        expect(sql).toMatch(/UPDATE derived_values SET is_current = false/);
        return { rowCount: 0, rows: [] };
      }, // flip previous current
      () => ({ rowCount: 1, rows: [] }), // derived insert
      () => ({ rowCount: 1, rows: [] }), // settle budget
    ]);

    const ok = await finishSentiment(client, {
      jobId: "1",
      articleId: "2",
      articleVersion: 1,
      workerId: "w1",
      promptVersion: "v1",
      inputHash: Buffer.alloc(32),
      truncated: false,
      trust: "normal",
      costMicro: 0,
      reservedMicro: 10000,
      providerBudgetKey: "jev",
      dayUtc: "2026-07-14",
      result: {
        value: { choice: "positive", confidence: 0.9 },
        raw: {},
        usage: {},
        model: "mock",
        origin: "mock",
      },
    });

    expect(ok).toBe(true);
    const allSql = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(allSql.some((s) => s.includes("INSERT INTO enrichments"))).toBe(true);
  });
});
