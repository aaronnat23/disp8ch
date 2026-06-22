export type AnswerConcisionProfile = {
  targetWords: string;
  riskLimit: number;
  testLimit: number;
  instruction: string;
};

export function buildConcisionGuard(message: string): AnswerConcisionProfile {
  const exhaustive = /\b(?:exhaustive|very detailed|all details|comprehensive|full plan|deep dive)\b/i.test(message);
  const brief = /\b(?:brief|short|concise|tl;dr|quick)\b/i.test(message);
  if (exhaustive) {
    return {
      targetWords: "as long as needed, but avoid repetition",
      riskLimit: 7,
      testLimit: 10,
      instruction: "The user asked for depth. Keep all material evidence, but remove repetition and generic filler.",
    };
  }
  if (brief) {
    return {
      targetWords: "250-600 words",
      riskLimit: 3,
      testLimit: 5,
      instruction: "The user asked for brevity. Lead with the answer and keep only the highest-signal evidence.",
    };
  }
  return {
    targetWords: "700-1200 words for broad answers",
    riskLimit: 5,
    testLimit: 8,
    instruction: [
      "Default broad-answer concision: aim for 700-1200 words unless the evidence genuinely requires more.",
      "Use tables only when they clarify evidence.",
      "Limit residual risks to the top 3-5.",
      "List only exact next tests or commands the user can run.",
    ].join("\n"),
  };
}

