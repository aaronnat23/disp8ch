import type { WorkTrailEventLite } from "./work-trail-strip";

export type WorkTrailOutcomePhase = {
  label: string;
  detail: string;
  complete: boolean;
};

export type WorkTrailOutcome = {
  eyebrow: string;
  title: string;
  summary: string;
  nextAction: string;
  resultName: string | null;
  criteriaCount: number;
  evidenceCount: number;
  phases: WorkTrailOutcomePhase[];
};

const includesEvent = (events: WorkTrailEventLite[], eventTypes: string[]) =>
  events.some((event) => eventTypes.includes(event.eventType));

const uniqueEventCount = (events: WorkTrailEventLite[], eventType: string) => {
  const matches = events.filter((event) => event.eventType === eventType);
  const identities = new Set(matches.map((event, index) => event.objectId || event.objectName || event.summary || `${eventType}-${index}`));
  return identities.size;
};

const latestEvent = (events: WorkTrailEventLite[], eventTypes: string[]) =>
  [...events].reverse().find((event) => eventTypes.includes(event.eventType)) ?? null;

export function summarizeWorkTrailOutcome(
  trail: { status: string; userMessage: string },
  events: WorkTrailEventLite[],
): WorkTrailOutcome {
  const decisionCaptured = includesEvent(events, ["live_session_saved", "council_completed", "confirmed"]);
  const ownershipAssigned = includesEvent(events, ["supervised_run_created", "plan_drafted", "object_created"]);
  const verified = includesEvent(events, ["supervised_run_completed", "validation_completed"]);
  const resultConnected = includesEvent(events, ["project_attached", "source_attached", "artifact_created", "supervised_run_completed"]);
  const deployment = latestEvent(events, ["deployment_created", "deployment_updated"]);
  const deploymentRevoked = latestEvent(events, ["deployment_revoked"]);
  const published = Boolean(deployment && (!deploymentRevoked || events.lastIndexOf(deployment) > events.lastIndexOf(deploymentRevoked)));
  const failed = trail.status === "failed" || includesEvent(events, ["step_failed", "supervised_run_failed"]);
  const criteriaCount = uniqueEventCount(events, "criterion_evaluated");
  const evidenceCount = uniqueEventCount(events, "evidence_recorded");
  const proofCount = criteriaCount || evidenceCount;
  const proofDetail = proofCount
    ? `${proofCount} ${proofCount === 1 ? "criterion" : "criteria"} cleared`
    : "Verification passed";
  const resultName = deployment?.objectName || latestEvent(events, ["project_attached", "artifact_created", "supervised_run_completed"])?.objectName || null;

  const phases: WorkTrailOutcomePhase[] = [
    { label: "Decision", detail: decisionCaptured ? "Source retained" : "Awaiting source", complete: decisionCaptured },
    { label: "Ownership", detail: ownershipAssigned ? "Roles assigned" : "Awaiting owners", complete: ownershipAssigned },
    { label: "Proof", detail: verified ? proofDetail : "Verification pending", complete: verified },
    { label: "Result", detail: resultConnected ? "Output connected" : "Output pending", complete: resultConnected },
    { label: "Release", detail: published ? "Public result live" : deploymentRevoked ? "Release revoked" : "Not published", complete: published },
  ];

  if (failed) {
    return {
      eyebrow: "Delivery stopped safely",
      title: "The release did not outrun its evidence.",
      summary: "The trail preserves the failed step and its context so the operator can repair the work without reconstructing the original decision.",
      nextAction: "Resolve the failed evidence or request human input, then resume from the same governed trail.",
      resultName,
      criteriaCount,
      evidenceCount,
      phases,
    };
  }

  if (published) {
    return {
      eyebrow: "Meeting to public result",
      title: "A verified public result is live.",
      summary: "The original decision became owned work, passed recorded verification, and reached an operator-controlled release.",
      nextAction: "Feedback and the next revision can start from the same decision, owners, evidence, source, and release record.",
      resultName,
      criteriaCount,
      evidenceCount,
      phases,
    };
  }

  if (verified) {
    return {
      eyebrow: "Verified outcome",
      title: "The work passed independent verification.",
      summary: `The decision, accountable delivery, and ${evidenceCount || criteriaCount || "required"} proof records remain connected while publication waits for the operator.`,
      nextAction: "Inspect the connected output and approve publication when its release boundary is acceptable.",
      resultName,
      criteriaCount,
      evidenceCount,
      phases,
    };
  }

  return {
    eyebrow: trail.status === "completed" ? "Completed handoff" : "Delivery in progress",
    title: trail.status === "completed" ? "The work finished with its context intact." : "The decision is moving through accountable work.",
    summary: "The trail keeps the originating request, ownership, linked outputs, and current delivery state together.",
    nextAction: trail.status === "completed" ? "Open a linked result or start the next revision from this record." : "Follow the active phase or inspect the event timeline for blockers.",
    resultName,
    criteriaCount,
    evidenceCount,
    phases,
  };
}
