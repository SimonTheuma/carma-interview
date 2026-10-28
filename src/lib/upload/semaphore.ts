const g = globalThis as typeof globalThis & { __mssUploadInFlight?: boolean };

export function tryAcquireUpload(): boolean {
  if (g.__mssUploadInFlight) return false;
  g.__mssUploadInFlight = true;
  return true;
}

export function releaseUpload(): void {
  g.__mssUploadInFlight = false;
}

export function uploadInFlight(): boolean {
  return Boolean(g.__mssUploadInFlight);
}
