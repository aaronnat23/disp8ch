import { isNoMutationRequest, hasQualityGap } from "./contract";

export function handleCouncilRequest(message: string): string | null {
  const msg = message.toLowerCase().trim();
  const noMutation = isNoMutationRequest(msg);

  if (/start.*council|run.*council|begin.*debate|launch.*council/i.test(msg)) {
    if (noMutation) {
      return `I understand you're asking about a council debate but don't want me to start one.

Council Overview:
- Proposer: presents the case (2 min)
- Critic: challenges assumptions and risks (2 min)
- Synthesizer: produces a balanced verdict (1 min)
- Vote threshold: majority

To configure manually: go to /council, select agents, set a topic, and click "Start Session". I can help you pick agents and craft a debate topic.`;
    }

    const topicMatch = msg.match(/(?:about|on|for|debate|discuss)\s+(.+?)(?:\s*$|\s+(?:using|with|in))/i);
    const topic = topicMatch?.[1]?.trim() || "the proposed topic";
    return `I'll prepare a council debate but I have NOT started it yet. Reply "confirm" to begin.

Council Session Draft:
- Topic: ${topic}
- Proposer: presents the case (2 min)
- Critic: challenges assumptions and risks (2 min)
- Synthesizer: produces a balanced verdict (1 min)
- Vote threshold: majority

You can adjust roles, time limits, or add participants before starting.`;
  }

  if (
    /council|debate|vote|deliberate/i.test(msg) &&
    /plan|propos|suggest|draft|how.*set.up|where\s+would|where\s+do|what.*for|how.*use|needed.*team/i.test(msg)
  ) {
    const base = `Council sessions use 3 roles to debate a topic:

Proposer — argues for the idea
Critic — finds weaknesses and risks
Synthesizer — produces a balanced verdict

To configure: go to /council, select agents, set a topic, and click "Start Session". I can also help you pick agents and craft a debate topic.

## Plain-English examples
Try: "Ask the leadership team to debate launch readiness"
Try: "Switch to council mode"
Try: "Show the active organization"`;

    if (hasQualityGap(msg, base) && /rounds/i.test(msg)) {
      return `${base}\n\nFor multi-round debates, each agent gets 2 minutes per round. You can set the number of rounds in the council session config.`;
    }
    return base;
  }

  return null;
}
