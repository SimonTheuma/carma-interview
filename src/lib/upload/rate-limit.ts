type Bucket = { timestamps: number[] };

const g = globalThis as typeof globalThis & { __mssUploadRate?: Map<string, Bucket> };

function store(): Map<string, Bucket> {
  if (!g.__mssUploadRate) g.__mssUploadRate = new Map();
  return g.__mssUploadRate;
}

/** Returns null if allowed, or retry-after seconds if limited. */
export function checkRateLimit(
  tokenFingerprint: string,
  limitPerHour: number,
  now = Date.now(),
): number | null {
  const buckets = store();
  const windowMs = 60 * 60 * 1000;
  let b = buckets.get(tokenFingerprint);
  if (!b) {
    b = { timestamps: [] };
    buckets.set(tokenFingerprint, b);
  }
  b.timestamps = b.timestamps.filter((t) => now - t < windowMs);
  if (b.timestamps.length >= limitPerHour) {
    const oldest = b.timestamps[0]!;
    return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
  }
  b.timestamps.push(now);
  return null;
}

export function resetRateLimitForTests(): void {
  store().clear();
}
