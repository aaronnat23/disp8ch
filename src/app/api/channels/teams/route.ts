import { NextRequest, NextResponse } from "next/server";
import {
  sendTeamsMessage,
  type TeamsActivity,
  assertAllowedTeamsServiceUrl,
  getTeamsStatus,
} from "@/lib/channels/teams";
import { evaluateChannelAccess } from "@/lib/channels/access";
import { routeToWorkflowWithDetails } from "@/lib/channels/router";
import {
  resolveChannelResponseWithFallback,
  resolveExplicitWorkflowNoMatchText,
} from "@/lib/channels/fallback-assistant";
import { runByTheWayQuestion } from "@/lib/channels/btw";
import { defaultChannelAgentId, persistChannelMessage } from "@/lib/channels/transcript";
import { scheduleSessionIndex } from "@/lib/memory/session-watcher";
import { createProvenance } from "@/lib/provenance";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { verifyTeamsIngress } from "@/lib/security/channel-jwt";

export const dynamic = "force-dynamic";
const TEAMS_MAX_BODY_BYTES = 128 * 1024;

/**
 * Webhook endpoint for Microsoft Teams Bot Framework.
 * Teams sends activities here; we route them through the workflow engine
 * and reply via the Bot Framework REST API.
 */
export async function POST(request: NextRequest) {
  try {
    const activity = await readCappedJson<TeamsActivity>(request, TEAMS_MAX_BODY_BYTES);
    const teamsAppId = getTeamsStatus().appId || String(process.env.TEAMS_APP_ID || "").trim();
    await verifyTeamsIngress(request, activity, teamsAppId);

    if (activity.type !== "message" || !activity.text?.trim()) {
      // Acknowledge non-message activities gracefully
      return NextResponse.json({ status: "ok" });
    }

    const text = activity.text.trim();
    const sender = activity.from.name || activity.from.id;
    const senderId = String(activity.from.id || sender).trim();
    const conversationId = activity.conversation.id;
    const serviceUrl = assertAllowedTeamsServiceUrl(activity.serviceUrl);
    const now = new Date().toISOString();
    const agentId = defaultChannelAgentId();
    const accessDecision = evaluateChannelAccess({
      channel: "teams",
      subjectKey: senderId,
      subjectLabel: sender,
    });
    if (!accessDecision.allowed) {
      if (accessDecision.replyMessage) {
        await sendTeamsMessage(serviceUrl, conversationId, accessDecision.replyMessage).catch(() => {});
      }
      return NextResponse.json({ status: "blocked" });
    }
    const btw = await runByTheWayQuestion({
      rawMessage: text,
      sessionId: `teams:${conversationId}`,
    });
    if (btw) {
      await sendTeamsMessage(serviceUrl, conversationId, btw.response || "No answer.").catch(() => {});
      return NextResponse.json({ status: "ok" });
    }
    const provenance = createProvenance("channel", "channel:teams", {
      channel: "teams",
      sessionId: `teams:${conversationId}`,
      sender,
      senderId,
    });

    const result = await routeToWorkflowWithDetails({
      triggerNodeType: "teams-trigger",
      channel: "teams",
      triggerData: {
        message: text,
        sender,
        senderId,
        conversationId,
        serviceUrl,
        channel: "teams",
        sessionId: `teams:${conversationId}`,
        timestamp: now,
      },
    });
    const explicitWorkflowNoMatchText = resolveExplicitWorkflowNoMatchText({
      rawMessage: text,
      routed: result,
    });
    const resolved = explicitWorkflowNoMatchText
      ? {
        responseText: explicitWorkflowNoMatchText,
        routeSource: result.source,
      }
      : await resolveChannelResponseWithFallback({
        routed: result,
        rawMessage: text,
        sessionId: `teams:${conversationId}`,
        agentId,
      });

    if (resolved.responseText) {
      persistChannelMessage({
        sessionId: `teams:${conversationId}`,
        role: "user",
        content: text,
        metadata: { channel: "teams", sender, senderId, conversationId, serviceUrl },
        provenance,
        agentId,
        createdAt: now,
      });
      persistChannelMessage({
        sessionId: `teams:${conversationId}`,
        role: "assistant",
        content: resolved.responseText,
        metadata: {
          channel: "teams",
          senderId,
          conversationId,
          serviceUrl,
          workflowId: result.workflowId,
          workflowName: result.workflowName,
          routeSource: resolved.routeSource,
          ...(resolved.fallbackAssistant ? { fallbackAssistant: resolved.fallbackAssistant } : {}),
          ...(resolved.sessionSnapshot ? { sessionSnapshot: resolved.sessionSnapshot } : {}),
        },
        provenance: {
          ...provenance,
          workflowId: result.workflowId ?? undefined,
          workflowName: result.workflowName ?? undefined,
          routeSource: resolved.routeSource,
        },
        agentId,
        createdAt: now,
      });
      scheduleSessionIndex(`teams:${conversationId}`, agentId);
      await sendTeamsMessage(serviceUrl, conversationId, resolved.responseText).catch(() => {});
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (String(error).includes("Teams serviceUrl")) {
      return NextResponse.json({ error: String(error) }, { status: 400 });
    }
    const message = String(error);
    const authFailure = /bearer|jwt|signing|issuer|audience|endorse|not configured/i.test(message);
    return NextResponse.json({ error: authFailure ? "Invalid Teams webhook authentication" : message }, { status: authFailure ? 401 : 500 });
  }
}
