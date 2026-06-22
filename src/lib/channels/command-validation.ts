export interface CommandValidationIssue {
  kind: "empty_url" | "unverified_url" | "unverified_package" | "dangerous_command" | "malformed_command";
  command: string;
  detail: string;
  line?: number;
}

export interface CommandValidationResult {
  ok: boolean;
  issues: CommandValidationIssue[];
  repairedAnswer: string;
}

const DANGEROUS_COMMANDS_IN_RESEARCH = [
  /\brm\s+-rf\b/i,
  /\bdrop\s+table\b/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

const MALFORMED_PATTERNS: Array<{ pattern: RegExp; kind: CommandValidationIssue["kind"]; detail: string }> = [
  {
    pattern: /curl\s+(?:-[a-zA-Z]+\s+)*-fsSL\s*\|/g,
    kind: "empty_url",
    detail: "curl -fsSL with no URL before pipe",
  },
  {
    pattern: /curl\s+(?:-[a-zA-Z]+\s+)*-fsSL\s*$/gm,
    kind: "empty_url",
    detail: "curl -fsSL with no URL at end of line",
  },
  {
    pattern: /(?:irm|iwr)\s*\|/gi,
    kind: "empty_url",
    detail: "PowerShell web request with no URL before pipe",
  },
  {
    pattern: /(?:irm|iwr)\s*$/gim,
    kind: "empty_url",
    detail: "PowerShell web request with no URL at end of line",
  },
];

function extractCodeBlocks(text: string): Array<{ block: string; startLine: number }> {
  const blocks: Array<{ block: string; startLine: number }> = [];
  const codeBlockRegex = /```(?:bash|sh|shell|powershell|ps1|cmd|bat)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const beforeMatch = text.slice(0, match.index);
    const startLine = (beforeMatch.match(/\n/g) || []).length + 1;
    blocks.push({ block: match[1], startLine });
  }
  return blocks;
}

function extractInlineCommands(text: string): Array<{ command: string; startLine: number }> {
  const commands: Array<{ command: string; startLine: number }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Detect lines that look like shell commands (start with common command prefixes)
    if (/^(?:curl|wget|pip|npm|yarn|apt|brew|dnf|pacman|choco|winget|irm|iwr|Invoke-WebRequest)\s/.test(line)) {
      commands.push({ command: line, startLine: i + 1 });
    }
  }
  return commands;
}

/**
 * Validates command blocks in an answer for malformed or dangerous commands.
 * Returns issues found and a repaired answer with bad commands replaced.
 */
export function validateAnswerCommands(answer: string): CommandValidationResult {
  const issues: CommandValidationIssue[] = [];
  let repairedAnswer = answer;

  // Check code blocks
  const codeBlocks = extractCodeBlocks(answer);
  for (const { block, startLine } of codeBlocks) {
    const blockLines = block.split("\n");
    for (let i = 0; i < blockLines.length; i++) {
      const line = blockLines[i];
      const actualLine = startLine + i;

      // Check for malformed patterns
      for (const { pattern, kind, detail } of MALFORMED_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          issues.push({ kind, command: line.trim(), detail, line: actualLine });
        }
      }

      // Check for dangerous commands in research context
      for (const dangerous of DANGEROUS_COMMANDS_IN_RESEARCH) {
        if (dangerous.test(line)) {
          issues.push({
            kind: "dangerous_command",
            command: line.trim(),
            detail: "Destructive command in research/answer context",
            line: actualLine,
          });
        }
      }
    }
  }

  // Check inline commands
  const inlineCommands = extractInlineCommands(answer);
  for (const { command, startLine } of inlineCommands) {
    for (const { pattern, kind, detail } of MALFORMED_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(command)) {
        issues.push({ kind, command, detail, line: startLine });
      }
    }
  }

  // Repair: replace malformed commands with guidance
  if (issues.length > 0) {
    let repaired = answer;
    for (const issue of issues) {
      if (issue.kind === "empty_url") {
        // Replace the malformed command with a note
        repaired = repaired.replace(
          issue.command,
          `<!-- Command removed: ${issue.detail} -->\n*Install command omitted — no verified URL was found for this package.*`,
        );
      } else if (issue.kind === "dangerous_command") {
        repaired = repaired.replace(
          issue.command,
          `<!-- Dangerous command removed: ${issue.detail} -->\n*Command omitted — destructive operations are not included in research answers.*`,
        );
      }
    }
    repairedAnswer = repaired;
  }

  return { ok: issues.length === 0, issues, repairedAnswer };
}
