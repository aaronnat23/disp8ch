import Link from "next/link";

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-md rounded-md border bg-card p-6">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Connection unavailable
        </div>
        <h1 className="mt-2 text-2xl font-semibold">Reconnect to continue</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          disp8ch needs the local server for chat, workflows, channels, and model calls. Keep the server running and reopen the app when the device is back online.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href="/chat"
            className="rounded-md border bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            Open Chat
          </Link>
          <Link
            href="/"
            className="rounded-md border px-3 py-2 text-sm font-medium text-foreground"
          >
            Dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}
