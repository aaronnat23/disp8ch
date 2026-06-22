import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getModelConfig } from "@/lib/agents/model-router";
import { callModel } from "@/lib/agents/multi-provider";
import { nanoid } from "nanoid";
import { normalizeWorkflowDefinition } from "@/lib/engine/workflow-normalize";

const generateSchema = z.object({
  description: z.string().min(4).max(1000),
});

const SYSTEM_PROMPT = `You are a workflow architect for disp8ch, an AI agent platform. Given a natural language description, output a valid disp8ch workflow JSON object with "nodes" and "edges" arrays. Respond ONLY with valid JSON — no markdown, no explanation.

Available node types (use these exact type strings):
- Triggers: manual-trigger, message-trigger (channel: "webchat"|"telegram"|"discord"|"whatsapp"), webhook-trigger (path, method), cron-trigger (expression, timezone)
- Agents: claude-agent (systemPrompt, temperature, maxTokens), parallel-agents, call-workflow (workflowId)
- Channels: send-webchat, send-telegram, send-discord, send-whatsapp, send-slack, send-email (host, port, subject), send-teams, send-bluebubbles
- Logic: if-else (condition), switch, delay (delayMs), set-variables (variables: {key:val}), filter (condition)
- Memory: memory-recall (query, limit), memory-store (type, content)
- Tools: http-request (url, method, body), run-code (code, language:"javascript"), read-file (path), write-file (path), board-task, document-tool, date-time, system-command
- Advanced: loop (maxIterations), aggregate, merge, error-handler, json-transform (transform), split-text (separator), regex-extract (pattern), database-query, git-operation, council

Template expressions: {{trigger.field}}, {{message.text}}, {{agent.response}}, {{run.result}}, {{http.body}}, {{memory.results}}, {{cron.triggeredAt}}

Node JSON shape: { "id": "<8-char nanoid>", "type": "<node-type>", "position": { "x": <number>, "y": <number> }, "data": { "label": "<label>", ...config } }
Edge JSON shape: { "id": "e-<source>-<target>", "source": "<nodeId>", "target": "<nodeId>" }
For if-else: true branch edge has "sourceHandle": "true", false branch has "sourceHandle": "false".

Layout: start nodes at x:100, space subsequent nodes x+300. Parallel branches use different y values (e.g. y:100, y:300).

Design the most effective workflow for the user's description. Keep it practical and concise (3-8 nodes typical). Always start with an appropriate trigger.`;

function buildFallbackWorkflow(description: string) {
  const triggerId = nanoid(8);
  const agentId = nanoid(8);
  const sendId = nanoid(8);
  const summaryPrompt = [
    "You are a workflow execution assistant.",
    "Complete the user's requested workflow outcome.",
    `Workflow goal: ${description}`,
    "Return a concise, actionable result that can be sent back to WebChat.",
  ].join("\n");

  return {
    nodes: [
      {
        id: triggerId,
        type: "manual-trigger",
        position: { x: 100, y: 160 },
        data: {
          label: "Manual Trigger",
        },
      },
      {
        id: agentId,
        type: "claude-agent",
        position: { x: 420, y: 160 },
        data: {
          label: "Plan And Execute",
          systemPrompt: summaryPrompt,
          temperature: 0.2,
          maxTokens: 1400,
        },
      },
      {
        id: sendId,
        type: "send-webchat",
        position: { x: 740, y: 160 },
        data: {
          label: "Reply In WebChat",
          message: "{{agent.response}}",
        },
      },
    ],
    edges: [
      { id: `e-${triggerId}-${agentId}`, source: triggerId, target: agentId },
      { id: `e-${agentId}-${sendId}`, source: agentId, target: sendId },
    ],
  };
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const body = await request.json() as unknown;
    const { description } = generateSchema.parse(body);

    const modelConfig = getModelConfig();
    if (!modelConfig.apiKey && modelConfig.provider !== "ollama" && modelConfig.provider !== "vllm" && modelConfig.provider !== "sglang" && modelConfig.provider !== "lmstudio") {
      return NextResponse.json({ success: false, error: "No LLM configured. Add a model in Settings → Models first." }, { status: 400 });
    }

    let parsed: { nodes?: unknown[]; edges?: unknown[] } | null = null;
    try {
      const result = await callModel({
        provider: modelConfig.provider,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl ?? undefined,
        systemPrompt: SYSTEM_PROMPT,
        userMessage: `Generate a disp8ch workflow for: ${description}`,
        temperature: 0.3,
        maxTokens: 3000,
      });

      const raw = (result.response ?? "").trim();
      const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      parsed = JSON.parse(jsonStr) as { nodes?: unknown[]; edges?: unknown[] };
    } catch {
      parsed = buildFallbackWorkflow(description);
    }

    if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) {
      parsed = buildFallbackWorkflow(description);
    }

    // Ensure all nodes have valid IDs
    const rawNodes = (parsed.nodes as Array<Record<string, unknown>>).map((n) => ({
      ...n,
      id: (typeof n.id === "string" && n.id) ? n.id : nanoid(8),
    }));

    // Normalize: infer missing messages, ensure labels/positions
    const normalized = normalizeWorkflowDefinition({
      nodes: rawNodes as any[],
      edges: (parsed.edges ?? []) as any[],
      source: "llm-generated",
    });

    return NextResponse.json({
      success: true,
      data: {
        nodes: normalized.nodes,
        edges: normalized.edges,
        ...(normalized.warnings.length > 0 ? { normalizationWarnings: normalized.warnings } : {}),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.errors[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
