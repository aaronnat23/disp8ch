/**
 * Converts markdown-like text to Slack mrkdwn format and chunks it.
 * Slack API limit is 4000 chars per message.
 */

const SLACK_MAX_LENGTH = 4000;

function markdownToMrkdwn(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // Headings → bold
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading?.[1]) {
        const plain = heading[1]
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/__([^_]+)__/g, "$1");
        return `*${plain}*`;
      }
      // HR → divider
      if (line.trim() === "---") {
        return "────────";
      }
      return line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function prepareSlackMrkdwnChunks(text: string): string[] {
  const converted = markdownToMrkdwn(text);
  if (converted.length <= SLACK_MAX_LENGTH) {
    return [converted];
  }

  const chunks: string[] = [];
  let remaining = converted;

  while (remaining.length > SLACK_MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", SLACK_MAX_LENGTH);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", SLACK_MAX_LENGTH);
    }
    if (splitAt <= 0) {
      splitAt = SLACK_MAX_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
