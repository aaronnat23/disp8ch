import { redirect } from "next/navigation";
import { TabRouteShellByMarker } from "@/components/perf/tab-route-shell-by-marker";

export default function SettingsPage({ searchParams }: { searchParams?: { tab?: string } }) {
  if (searchParams?.tab === "mcp") redirect("/mcp");
  return <TabRouteShellByMarker marker="settings" />;
}
