"use client";

import { cn } from "@/lib/utils";
import { Scale, Sparkles, Users } from "lucide-react";
import { CourtAgentSeat } from "./court-agent-seat";
import { CourtPodium } from "./court-podium";
import { CourtVoteRail } from "./court-vote-rail";
import { CourtRoundTimeline } from "./court-round-timeline";
import { CourtEvidenceStrip } from "./court-evidence-strip";
import { CourtTranscript } from "./court-transcript";
import type { CourtOpinion, CourtParticipant, CourtSource, CourtTallyEntry } from "./court-types";

export type { CourtOpinion, CourtParticipant, CourtSource, CourtTallyEntry, CourtAgentState } from "./court-types";

const MAX_VISIBLE_SEATS = 12;

export type CourtStageWebChatAction = {
  label: string;
  prompt: string;
};

export type CourtStageProps = {
  topic: string;
  isRunning: boolean;
  /** The session has finished (a result exists), even if no winner emerged. */
  complete?: boolean;
  mode: string;
  decisionMode: string;
  round: number;
  totalRounds: number;
  participants: CourtParticipant[];
  opinions: CourtOpinion[];
  tally?: CourtTallyEntry[];
  verdict?: string | null;
  conclusion?: string | null;
  sources?: CourtSource[];
  /** Whether moderator/synthesis is configured for this session. */
  hasModerator?: boolean;
  /** Optional explicit reduced-motion flag (system pref is also honoured in CSS). */
  reducedMotion?: boolean;
  /** Prefilled WebChat follow-ups derived by the parent from real session state. */
  webChatActions?: CourtStageWebChatAction[];
  onAskWebChat?: (prompt: string) => void;
};

function unitLabelFor(decisionMode: string): string {
  if (decisionMode === "ranked") return "points";
  if (decisionMode === "weighted") return "weight";
  return "votes";
}

/**
 * Pure renderer for the Council Court Stage. Receives derived UI state and draws
 * the chamber: status rail, judge bench, agent seats, podium, vote rail, round
 * timeline, evidence strip, and (when complete) WebChat follow-up affordances.
 *
 * It never fetches and holds no council business logic.
 */
export function CourtStage(props: CourtStageProps) {
  const {
    topic,
    isRunning,
    complete,
    mode,
    decisionMode,
    round,
    totalRounds,
    participants,
    opinions,
    tally = [],
    verdict,
    conclusion,
    sources = [],
    hasModerator,
    reducedMotion,
    webChatActions = [],
    onAskWebChat,
  } = props;

  const settled = complete ?? (!isRunning && Boolean(verdict));
  const judge = participants.find((p) => p.isJudge) ?? null;
  const floor = participants.filter((p) => !judge || p.agentId !== judge.agentId);
  const visibleFloor = floor.slice(0, MAX_VISIBLE_SEATS);
  const overflow = Math.max(0, floor.length - visibleFloor.length);

  const speaking = participants.find((p) => p.state === "speaking") ?? null;
  const current = opinions.length > 0 ? opinions[opinions.length - 1] : null;
  const votedCount = participants.filter((p) => p.vote).length;

  const statusLabel = isRunning ? "Council in session" : settled ? "Court adjourned" : "Court ready";

  return (
    <div
      className={cn("space-y-3", reducedMotion ? "court-stage--reduced-motion" : "")}
      data-court-stage="1"
      data-court-running={isRunning ? "1" : "0"}
      data-court-settled={settled ? "1" : "0"}
    >
      {/* Status rail */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-mono uppercase tracking-widest",
              isRunning ? "bg-terminal-red/15 text-terminal-red" : settled ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground",
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", isRunning ? "bg-terminal-red" : settled ? "bg-emerald-400" : "bg-muted-foreground")} />
            {statusLabel}
          </span>
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline" title={topic}>
            {topic}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <span className="rounded border border-border px-1.5 py-0.5">{mode}</span>
          <span className="rounded border border-border px-1.5 py-0.5">{decisionMode}</span>
          <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5">
            <Users className="h-3 w-3" />
            {votedCount}/{participants.length}
          </span>
        </div>
      </div>

      <CourtRoundTimeline round={round} totalRounds={totalRounds} isRunning={isRunning} settled={settled} />

      {/* Judge / moderator bench */}
      {judge ? (
        <div
          className={cn(
            "flex items-center gap-3 rounded-lg border px-3 py-2.5",
            settled ? "border-emerald-500/40 bg-emerald-500/[0.05]" : "border-border bg-card",
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              <Scale className="h-3.5 w-3.5 text-amber-400" />
              {hasModerator ? "Moderator bench" : "Bench"}
            </div>
            <div className="mt-0.5 truncate text-sm font-semibold">{judge.agentName}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {judge.roleTitle}
              {" · "}
              {settled
                ? verdict
                  ? `ruling: ${verdict}`
                  : "no decision reached"
                : isRunning
                  ? hasModerator
                    ? "coordinating & preparing synthesis"
                    : "coordinating deliberation"
                  : "ready to open session"}
            </div>
          </div>
          {hasModerator ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded border border-blue-400/40 bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-blue-300">
              <Sparkles className="h-3 w-3" />
              Synthesis
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Main: chamber + side rail */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3">
          <CourtPodium
            isRunning={isRunning}
            settled={settled}
            current={current}
            nextSpeaker={speaking ? speaking.agentName : null}
            verdict={settled ? verdict : null}
          />
          {visibleFloor.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {visibleFloor.map((participant) => (
                <CourtAgentSeat key={`seat-${participant.agentId}`} participant={participant} />
              ))}
              {overflow > 0 ? (
                <div className="flex h-[68px] items-center justify-center rounded-lg border border-dashed border-border bg-card text-[11px] text-muted-foreground">
                  +{overflow} observers
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
              Select at least 2 agents to seat the chamber.
            </div>
          )}
        </div>

        <div className="space-y-3">
          <CourtVoteRail tally={tally} winner={verdict} unitLabel={unitLabelFor(decisionMode)} settled={settled} />
          {settled && conclusion ? (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/[0.06] px-3 py-2.5">
              <div className="mb-1 text-[10px] font-mono uppercase tracking-widest text-emerald-400">Court conclusion</div>
              <p className="line-clamp-4 text-xs text-muted-foreground">{conclusion}</p>
            </div>
          ) : null}
        </div>
      </div>

      {/* Deliberation transcript: the actual arguments behind the decision. */}
      <CourtTranscript opinions={opinions} isRunning={isRunning} />

      <CourtEvidenceStrip sources={sources} />

      {/* WebChat follow-ups — only after a verdict, and only from real state. */}
      {settled && webChatActions.length > 0 && onAskWebChat ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-muted/10 px-2.5 py-2">
          <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            <Sparkles className="h-3 w-3" />
            Ask WebChat
          </span>
          {webChatActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => onAskWebChat(action.prompt)}
              className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] transition-colors hover:border-terminal-red/60 hover:text-foreground"
              title={action.prompt}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
