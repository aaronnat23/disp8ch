export type ExplicitWorkflowRunRequest = {
  workflowName: string;
  input: string;
};

const DEFAULT_WORKFLOW_INPUT = "Run now and return the completed status and final result.";

function cleanWorkflowName(value: string): string {
  return value.trim().replace(/^["“”']+|["“”']+$/g, "").trim();
}

function cleanWorkflowInput(value: string): string {
  return value.trim().replace(/^[\s.,;:!?-]+/, "").trim() || DEFAULT_WORKFLOW_INPUT;
}

export function parseExplicitWorkflowRunRequest(raw: string): ExplicitWorkflowRunRequest | null {
  const value = String(raw || "").trim();
  if (!value) return null;

  const documented = value.match(
    /^(?:run|execute|trigger|start)\s+(?:the\s+)?(?:workflow|template)\s*:\s*(.+?)\s*::\s*([\s\S]+)$/i,
  );
  if (documented?.[1]) {
    return {
      workflowName: cleanWorkflowName(documented[1]),
      input: cleanWorkflowInput(documented[2] || ""),
    };
  }

  const quotedCalled = value.match(
    /^(?:run|execute|trigger|start)\s+(?:the\s+)?(?:workflow|template)\s+(?:called|named)\s+["“]([^"”]+)["”]([\s\S]*)$/i,
  );
  if (quotedCalled?.[1]) {
    return {
      workflowName: cleanWorkflowName(quotedCalled[1]),
      input: cleanWorkflowInput(quotedCalled[2] || ""),
    };
  }

  const quotedBeforeNoun = value.match(
    /^(?:run|execute|trigger|start)\s+["“]([^"”]+)["”]\s+(?:workflow|template)\b([\s\S]*)$/i,
  );
  if (quotedBeforeNoun?.[1]) {
    return {
      workflowName: cleanWorkflowName(quotedBeforeNoun[1]),
      input: cleanWorkflowInput(quotedBeforeNoun[2] || ""),
    };
  }

  const unquotedCalled = value.match(
    /^(?:run|execute|trigger|start)\s+(?:the\s+)?(?:workflow|template)\s+(?:called|named)\s+([^.!?]+)(?:[.!?]\s*([\s\S]*))?$/i,
  );
  if (unquotedCalled?.[1]) {
    return {
      workflowName: cleanWorkflowName(unquotedCalled[1]),
      input: cleanWorkflowInput(unquotedCalled[2] || ""),
    };
  }

  return null;
}

export function canonicalizeExplicitWorkflowRunRequest(raw: string): string | null {
  const parsed = parseExplicitWorkflowRunRequest(raw);
  if (!parsed) return null;
  return `run workflow: ${parsed.workflowName} :: ${parsed.input}`;
}
