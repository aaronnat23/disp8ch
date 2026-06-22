const CHANNEL_BOARD_LIST_RESPONSE_CODE = `const payload = input.body || {};
const rows = Array.isArray(payload.data) ? payload.data : [];
if (!input.ok || !payload.success) {
  const err = payload.error || input.bodyText || "unknown error";
  result = { response: "Unable to fetch board tasks: " + err };
} else if (rows.length === 0) {
  result = { response: "No tasks on **main-board** yet. Send a plain-English message like 'add a task to my board' to create one." };
} else {
  const top = rows.slice(0, 6).map((task, index) => {
    const status = String(task.status || "unknown").replace(/_/g, " ").toLowerCase();
    return (index + 1) + ". " + task.title + "\\n" +
      "status: " + status + "\\n" +
      "id: " + task.id;
  }).join("\\n\\n");
  const moreLine = rows.length > 6 ? "\\n\\nShowing first 6 of " + rows.length + "." : "";
  result = {
    response: "Main Board tasks on main-board (" + rows.length + " total):\\n\\n" + top + moreLine
  };
}`;

type WorkflowNode = {
  type?: string;
  data?: {
    label?: string;
    code?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function isLegacyChannelBoardListFormatter(node: WorkflowNode): boolean {
  return (
    node.type === "run-code" &&
    node.data?.label === "Format List Response" &&
    typeof node.data.code === "string" &&
    node.data.code.includes('response: "Main Board tasks (') &&
    node.data.code.includes('rows.slice(0, 8)')
  );
}

export function upgradeChannelBoardWorkflowNodes(nodesJson: string): string {
  try {
    const parsed = JSON.parse(nodesJson) as unknown;
    if (!Array.isArray(parsed)) {
      return nodesJson;
    }

    let changed = false;
    const nextNodes = parsed.map((node) => {
      if (!node || typeof node !== "object") {
        return node;
      }

      const typedNode = node as WorkflowNode;
      if (!isLegacyChannelBoardListFormatter(typedNode)) {
        return node;
      }

      changed = true;
      return {
        ...typedNode,
        data: {
          ...typedNode.data,
          code: CHANNEL_BOARD_LIST_RESPONSE_CODE,
        },
      };
    });

    return changed ? JSON.stringify(nextNodes) : nodesJson;
  } catch {
    return nodesJson;
  }
}

export { CHANNEL_BOARD_LIST_RESPONSE_CODE };
