/**
 * Shared overlay-prop helper for node renderers.
 *
 * Every node renderer extracts `disabled`, `_runStatus`, and `_runDurationMs`
 * from its `data` prop and forwards them to BaseNode. The canvas injects
 * `_runStatus`/`_runDurationMs` onto each node's data from the execution
 * store before passing them to ReactFlow.
 */

import type { NodeConfig } from "@/types/workflow";

export type NodeOverlayProps = {
  disabled?: boolean;
  runStatus?: "running" | "completed" | "failed" | "skipped" | "cancelled" | null;
  runDurationMs?: number;
};

export function readNodeOverlayProps(data: unknown): NodeOverlayProps {
  const d = (data ?? {}) as NodeConfig & {
    disabled?: boolean;
    _runStatus?: "running" | "completed" | "failed" | "skipped" | "cancelled" | null;
    _runDurationMs?: number;
  };
  return {
    disabled: d.disabled === true,
    runStatus: d._runStatus ?? null,
    runDurationMs: typeof d._runDurationMs === "number" ? d._runDurationMs : undefined,
  };
}
