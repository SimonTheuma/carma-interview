import type pg from "pg";

export async function ensureBudgetDay(
  db: pg.PoolClient,
  provider: string,
  dayUtc: string,
  currency: string,
  capMicro: number,
): Promise<void> {
  await db.query(
    `INSERT INTO llm_budget_ledger (provider, day_utc, currency, cap_micro)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT DO NOTHING`,
    [provider, dayUtc, currency, capMicro],
  );
}

export async function reserveBudget(
  db: pg.PoolClient,
  provider: string,
  dayUtc: string,
  amountMicro: number,
): Promise<number | null> {
  const res = await db.query<{ remaining_micro: string }>(
    `UPDATE llm_budget_ledger
        SET reserved_micro = reserved_micro + $3
      WHERE provider = $1 AND day_utc = $2::date
        AND reserved_micro + spent_micro + $3 <= cap_micro
      RETURNING cap_micro - reserved_micro - spent_micro AS remaining_micro`,
    [provider, dayUtc, amountMicro],
  );
  if (!res.rows[0]) return null;
  return Number(res.rows[0].remaining_micro);
}

export async function settleBudget(
  db: pg.PoolClient,
  provider: string,
  dayUtc: string,
  reservedMicro: number,
  spentMicro: number,
): Promise<void> {
  await db.query(
    `UPDATE llm_budget_ledger
        SET reserved_micro = reserved_micro - $3,
            spent_micro = spent_micro + $4
      WHERE provider = $1 AND day_utc = $2::date`,
    [provider, dayUtc, reservedMicro, spentMicro],
  );
}

export async function releaseBudget(
  db: pg.PoolClient,
  provider: string,
  dayUtc: string,
  reservedMicro: number,
): Promise<void> {
  await db.query(
    `UPDATE llm_budget_ledger
        SET reserved_micro = greatest(0, reserved_micro - $3)
      WHERE provider = $1 AND day_utc = $2::date`,
    [provider, dayUtc, reservedMicro],
  );
}

export function dollarsToMicro(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

export function estimateCostMicro(
  inputTokens: number,
  outputTokens: number,
  priceInPerMtok: number,
  priceOutPerMtok: number,
): number {
  const dollars =
    (inputTokens / 1_000_000) * priceInPerMtok + (outputTokens / 1_000_000) * priceOutPerMtok;
  return dollarsToMicro(dollars);
}
