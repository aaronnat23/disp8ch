"use client";

import { memo } from "react";
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
export const CourtStage = memo(function CourtStage(props: CourtStageProps) {
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
      <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-card px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-0.5 font-display text-[10px] font-semibold uppercase tracking-[0.14em]",
              isRunning ? "bg-terminal-red/15 text-terminal-red" : settled ? "bg-foreground/10 text-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            <span className={cn("h-1.5 w-1.5", isRunning ? "bg-terminal-red pulse-red" : settled ? "bg-foreground/70" : "bg-muted-foreground")} />
            {statusLabel}
          </span>
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline" title={topic}>
            {topic}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <span className="border border-border px-1.5 py-0.5">{mode}</span>
          <span className="border border-border px-1.5 py-0.5">{decisionMode}</span>
          <span className="inline-flex items-center gap-1 border border-border px-1.5 py-0.5">
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
            "flex items-center gap-3 border px-3 py-2.5",
            settled ? "border-foreground/30 bg-secondary/40" : "border-border bg-card",
          )}
          data-court-judge="1"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Scale className="h-3.5 w-3.5 text-terminal-red" />
              {hasModerator ? "Moderator bench" : "Bench"}
            </div>
            <div className="mt-0.5 truncate font-display text-sm font-semibold">{judge.agentName}</div>
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
            <span className="inline-flex shrink-0 items-center gap-1 border border-terminal-red/40 bg-terminal-red/5 px-1.5 py-0.5 font-display text-[9px] font-semibold uppercase tracking-wider text-terminal-red">
              <Sparkles className="h-3 w-3" />
              Synthesis
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Main: chamber + side rail */}
      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-3">
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
                <div className="flex h-[68px] items-center justify-center border border-dashed border-border bg-card font-mono text-[11px] text-muted-foreground">
                  +{overflow} observers
                </div>
              ) : null}
            </div>
          ) : (
            <div className="border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
              Select at least 2 agents to seat the chamber.
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-3">
          <CourtVoteRail tally={tally} winner={verdict} unitLabel={unitLabelFor(decisionMode)} settled={settled} />
          {settled && conclusion ? (
            <div className="court-stamp border border-terminal-red/40 bg-terminal-red/[0.04] px-3 py-2.5">
              <div className="mb-1 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-terminal-red">Court conclusion</div>
              <p className="line-clamp-6 text-xs text-muted-foreground">{conclusion}</p>
            </div>
          ) : null}
        </div>
      </div>

      {/* Deliberation transcript: the actual arguments behind the decision. */}
      <CourtTranscript opinions={opinions} isRunning={isRunning} />

      <CourtEvidenceStrip sources={sources} />

      {/* WebChat follow-ups — only after a verdict, and only from real state. */}
      {settled && webChatActions.length > 0 && onAskWebChat ? (
        <div className="flex flex-wrap items-center gap-1.5 border border-border/60 bg-muted/10 px-2.5 py-2">
          <span className="inline-flex items-center gap-1 font-display text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Sparkles className="h-3 w-3" />
            Ask WebChat
          </span>
          {webChatActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => onAskWebChat(action.prompt)}
              className="clip-chamfer-sm bg-secondary px-2.5 py-0.5 text-[11px] transition-colors hover:bg-terminal-red hover:text-primary-foreground"
              title={action.prompt}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
