import { describe, expect, it, vi } from "vitest";
import { releaseUnchanged } from "@/worker/claim";
import type pg from "pg";

describe("F-BRK-ATT releaseUnchanged", () => {
  it("decrements attempts when releasing a claim without consuming it", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toMatch(/attempts = greatest\(0, attempts - 1\)/);
      expect(sql).toMatch(/state = 'queued'/);
      expect(params).toEqual(["42", "worker-1"]);
      return { rowCount: 1, rows: [] };
    });
    const client = { query } as unknown as pg.PoolClient;
    await releaseUnchanged(client, "42", "worker-1");
    expect(query).toHaveBeenCalledOnce();
  });
});
