import { TabRouteShellByMarker } from "@/components/perf/tab-route-shell-by-marker";
import { preloadHierarchyBootstrap, bootstrapDomId } from "@/lib/server/preload-bootstrap";

export default async function HierarchyPage() {
  const bootstrap = await preloadHierarchyBootstrap();
  return (
    <>
      {bootstrap ? (
        <script
          id={bootstrapDomId("hierarchy")}
          type="application/json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(bootstrap) }}
        />
      ) : null}
      <TabRouteShellByMarker marker="hierarchy" />
    </>
  );
}
