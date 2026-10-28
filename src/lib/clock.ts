/** Injectable time seam for tests (testing spec section 2). */

export type Clock = {
  now(): Date;
  sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createFakeClock(start: Date = new Date("2026-07-14T12:00:00.000Z")): Clock & {
  advance(ms: number): void;
  set(date: Date): void;
} {
  let current = start.getTime();
  const waiters: Array<{ at: number; resolve: () => void }> = [];

  function wake(): void {
    const ready = waiters.filter((w) => w.at <= current);
    for (const w of ready) {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      w.resolve();
    }
  }

  return {
    now: () => new Date(current),
    sleep: (ms) =>
      new Promise((resolve) => {
        waiters.push({ at: current + ms, resolve });
        wake();
      }),
    advance(ms: number) {
      current += ms;
      wake();
    },
    set(date: Date) {
      current = date.getTime();
      wake();
    },
  };
}
