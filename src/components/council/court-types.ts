/**
 * Shared types for the Council Court Stage (UI-only, props-driven).
 *
 * These describe what the stage *renders*, not how a council runs. The council
 * page derives this state from real session data (streaming opinions, the final
 * result, and selected participants) and hands it to the pure stage renderer.
 */

export type CourtAgentState =
  | "waiting"
  | "thinking"
  | "speaking"
  | "voted"
  | "dissenting"
  | "simulated"
  | "error";

export type CourtParticipant = {
  agentId: string;
  agentName: string;
  roleTitle: string;
  state: CourtAgentState;
  vote: string | null;
  confidence: number | null;
  isJudge?: boolean;
  isWinner?: boolean;
  simulated?: boolean;
  error?: string | null;
};

export type CourtOpinion = {
  agentId: string;
  agentName: string;
  roleTitle: string;
  stance: string;
  vote: string;
  confidence: number;
  concerns?: string;
  simulated?: boolean;
  error?: string | null;
};

export type CourtSource = {
  id: string;
  label: string;
  kind: string;
};

export type CourtTallyEntry = {
  option: string;
  votes: number;
};
