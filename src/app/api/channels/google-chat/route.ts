import { NextRequest, NextResponse } from "next/server";
import { initializeDatabase } from "@/lib/db";
import { evaluateChannelAccess } from "@/lib/channels/access";
import { routeToWorkflowWithDetails } from "@/lib/channels/router";
import {
  NO_WORKFLOW_FALLBACK_TEXT,
  resolveChannelResponseWithFallback,
  resolveExplicitWorkflowNoMatchText,
} from "@/lib/channels/fallback-assistant";
import { presentChannelResponse } from "@/lib/channels/presentation";
import { defaultChannelAgentId, persistChannelMessage } from "@/lib/channels/transcript";
import { runByTheWayQuestion } from "@/lib/channels/btw";
import { scheduleSessionIndex } from "@/lib/memory/session-watcher";
import { createProvenance } from "@/lib/provenance";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { verifyGoogleChatIngress } from "@/lib/security/channel-jwt";

export const dynamic = "force-dynamic";
const GOOGLE_CHAT_MAX_BODY_BYTES = 128 * 1024;

function extractGoogleChatText(payload: Record<string, unknown>): string {
  const message = payload.message as Record<string, unknown> | undefined;
  const raw = String(message?.text || "").trim();
  if (!raw) return "";

  // Remove bot mention prefix like: <users/123> hello
  return raw.replace(/^<users\/[\w-]+>\s*/i, "").trim();
}

export async function POST(request: NextRequest) {
  try {
    initializeDatabase();
    await verifyGoogleChatIngress(request, String(process.env.GOOGLE_CHAT_AUDIENCE || "").trim());
    const body = await readCappedJson<Record<string, unknown>>(request, GOOGLE_CHAT_MAX_BODY_BYTES);

    const type = String(body.type || "");
    if (type === "ADDED_TO_SPACE") {
      return NextResponse.json({ text: "Connected. Send a message and I will route it through the active workflow." });
    }

    if (type && type !== "MESSAGE") {
      return NextResponse.json({ text: "Event received." });
    }

    const messageText = extractGoogleChatText(body);
    if (!messageText) {
      return NextResponse.json({ text: "Please send text content." });
    }

    const space = body.space as Record<string, unknown> | undefined;
    const user = body.user as Record<string, unknown> | undefined;
    const messageObj = body.message as Record<string, unknown> | undefined;
    const thread = messageObj?.thread as Record<string, unknown> | undefined;

    const spaceName = String(space?.name || "unknown-space");
    const sender = String(user?.displayName || user?.name || "google-chat-user");
    const senderId = String(user?.name || sender).trim();
    const threadName = String(thread?.name || "");
    const sessionId = `google-chat:${spaceName}`;
    const now = new Date().toISOString();

    const accessDecision = evaluateChannelAccess({
      channel: "google-chat",
      subjectKey: senderId,
      subjectLabel: sender,
    });
    if (!accessDecision.allowed) {
      return NextResponse.json({
        text: accessDecision.replyMessage || "This Google Chat sender is not approved for access.",
      });
    }

    const btw = await runByTheWayQuestion({
      rawMessage: messageText,
      sessionId,
    });
    if (btw) {
      return NextResponse.json({ text: presentChannelResponse("google-chat", btw.response || "No answer.") });
    }

    const agentId = defaultChannelAgentId();
    const provenance = createProvenance("channel", "channel:google-chat", {
      channel: "google-chat",
      sessionId,
      sender,
      senderId,
    });
    persistChannelMessage({
      sessionId,
      role: "user",
      content: messageText,
      metadata: { channel: "google-chat", spaceName, sender, senderId, threadName },
      provenance,
      agentId,
      createdAt: now,
    });

    const routed = await routeToWorkflowWithDetails({
      triggerNodeType: "message-trigger",
      channel: "google-chat",
      triggerData: {
        message: messageText,
        sender,
        senderId,
        channel: "google-chat",
        spaceName,
        threadName,
        sessionId,
        timestamp: now,
      },
    });
    const explicitWorkflowNoMatchText = resolveExplicitWorkflowNoMatchText({
      rawMessage: messageText,
      routed,
    });
    const resolved = explicitWorkflowNoMatchText
      ? {
        responseText: explicitWorkflowNoMatchText,
        routeSource: routed.source,
      }
      : await resolveChannelResponseWithFallback({
        routed,
        rawMessage: messageText,
        sessionId,
        agentId,
      });

    const response = presentChannelResponse(
      "google-chat",
      resolved.responseText || NO_WORKFLOW_FALLBACK_TEXT,
    );

    persistChannelMessage({
      sessionId,
      role: "assistant",
      content: response,
      metadata: {
        channel: "google-chat",
        spaceName,
        senderId,
        threadName,
        workflowId: routed.workflowId,
        workflowName: routed.workflowName,
        routeSource: resolved.routeSource,
        ...(resolved.fallbackAssistant ? { fallbackAssistant: resolved.fallbackAssistant } : {}),
        ...(resolved.sessionSnapshot ? { sessionSnapshot: resolved.sessionSnapshot } : {}),
      },
      provenance: {
        ...provenance,
        workflowId: routed.workflowId ?? undefined,
        workflowName: routed.workflowName ?? undefined,
        routeSource: resolved.routeSource,
      },
      agentId,
      createdAt: now,
    });
    scheduleSessionIndex(sessionId, agentId);

    return NextResponse.json({ text: response });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ text: error.message }, { status: 413 });
    }
    const message = String(error);
    const authFailure = /bearer|jwt|signing|issuer|audience|certificate|not configured|email/i.test(message);
    return NextResponse.json({ text: authFailure ? "Invalid Google Chat webhook authentication" : `Error: ${message}` }, { status: authFailure ? 401 : 500 });
  }
}
