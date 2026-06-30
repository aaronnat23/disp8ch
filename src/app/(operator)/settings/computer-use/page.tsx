import ComputerUsePanel from "@/components/settings/computer-use-panel";

export const dynamic = "force-dynamic";

export default function ComputerUseSettingsPage() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Computer Use</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Optional desktop control (beta). Off by default; enable and verify before use.
      </p>
      <ComputerUsePanel />
    </div>
  );
}
