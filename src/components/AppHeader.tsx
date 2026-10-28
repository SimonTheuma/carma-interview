import Link from "next/link";

export function AppHeader() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-baseline gap-6">
        <Link href="/" className="text-lg font-semibold text-foreground no-underline">
          Media Signal
        </Link>
        <nav className="flex gap-4 text-sm" aria-label="Primary">
          <Link href="/" className="text-foreground no-underline hover:underline">
            Search
          </Link>
          <Link href="/trends" className="text-foreground no-underline hover:underline">
            Trends
          </Link>
          <Link href="/status" className="text-foreground no-underline hover:underline">
            Status
          </Link>
          <Link href="/upload" className="text-foreground no-underline hover:underline">
            Upload
          </Link>
        </nav>
      </div>
    </header>
  );
}
