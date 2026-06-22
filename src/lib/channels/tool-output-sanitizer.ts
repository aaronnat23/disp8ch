const CLI_HELP_PATTERNS = [
  /^\s*usage:\s+/im,
  /^\s*(?:options|commands|diff output format options|common options):\s*$/im,
  /\bNot a git repository\b/i,
  /\bfatal:\s+/i,
  /\bTraceback \(most recent call last\):/i,
];

export function isRawCliHelpOrToolDump(text: string): boolean {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (CLI_HELP_PATTERNS.some((pattern) => pattern.test(value))) return true;

  const optionLines = value
    .split(/\r?\n/)
    .filter((line) => /^\s{0,4}--?[A-Za-z0-9][\w-]+(?:[=\s]|,|$)/.test(line)).length;
  return optionLines >= 8 && optionLines / Math.max(1, value.split(/\r?\n/).length) > 0.25;
}

export function summarizeToolFailureForUser(text: string): string {
  const value = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!value) return "The tool returned no usable output.";
  if (/\bNot a git repository\b/i.test(value)) {
    return "The code review tool could not read a Git diff because the workspace is not a Git repository. I will inspect files directly instead.";
  }
  const firstUsefulLine = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !/^\s*usage:\s+/i.test(line) && !/^--?/.test(line));
  return firstUsefulLine
    ? `The tool returned an unusable diagnostic: ${firstUsefulLine.slice(0, 220)}`
    : "The tool returned CLI help instead of inspection evidence.";
}
