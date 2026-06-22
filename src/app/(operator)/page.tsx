import { TabRouteShellByMarker } from "@/components/perf/tab-route-shell-by-marker";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { preloadDashboardBootstrap, bootstrapDomId } from "@/lib/server/preload-bootstrap";
import { redirect } from "next/navigation";

function needsOnboarding(): boolean {
  try {
    initializeDatabase();
    const db = getSqlite();
    const row = db
      .prepare("SELECT onboarding_done FROM app_config WHERE id = 'default'")
      .get() as { onboarding_done?: number } | undefined;
    return row?.onboarding_done !== 1;
  } catch {
    return true;
  }
}

// Async server component: pre-fetches bootstrap data from SQLite and inlines it
// into the rendered HTML, so the client-side dashboard can skip the
// /api/dashboard/bootstrap roundtrip on first paint.
export default async function DashboardPage() {
  if (needsOnboarding()) redirect("/onboarding");

  const bootstrap = await preloadDashboardBootstrap();
  return (
    <>
      {bootstrap ? (
        <script
          id={bootstrapDomId("dashboard")}
          type="application/json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(bootstrap) }}
        />
      ) : null}
      <TabRouteShellByMarker marker="dashboard" />
    </>
  );
}
