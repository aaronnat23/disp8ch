const PORTABLE_ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BLOCKED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "BASH_ENV",
  "ENV",
  "GIT_EXTERNAL_DIFF",
  "GIT_EXEC_PATH",
  "SHELL",
  "SHELLOPTS",
  "PS4",
  "GCONV_PATH",
  "IFS",
  "SSLKEYLOGFILE",
]);

const BLOCKED_ENV_PREFIXES = ["DYLD_", "LD_", "BASH_FUNC_"];

const BLOCKED_OVERRIDE_KEYS = new Set([
  "HOME",
  "ZDOTDIR",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_PROXY_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "LESSOPEN",
  "LESSCLOSE",
  "PAGER",
  "MANPAGER",
  "GIT_PAGER",
  "EDITOR",
  "VISUAL",
  "FCEDIT",
  "SUDO_EDITOR",
  "PROMPT_COMMAND",
  "HISTFILE",
  "PERL5DB",
  "PERL5DBCMD",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "PYTHONSTARTUP",
  "WGETRC",
  "CURL_HOME",
  "PATH",
]);

const BLOCKED_OVERRIDE_PREFIXES = ["GIT_CONFIG_", "NPM_CONFIG_"];

function normalizeEnvVarKey(rawKey: string): string | null {
  const key = rawKey.trim();
  if (!key || !PORTABLE_ENV_VAR_KEY.test(key)) {
    return null;
  }
  return key;
}

function isBlockedKey(key: string, blockedKeys: Set<string>, blockedPrefixes: string[]): boolean {
  const upper = key.toUpperCase();
  if (blockedKeys.has(upper)) return true;
  return blockedPrefixes.some((prefix) => upper.startsWith(prefix));
}

export function sanitizeHostExecEnv(params?: {
  baseEnv?: Record<string, string | undefined>;
  overrides?: Record<string, string> | null;
}): Record<string, string> {
  const baseEnv = params?.baseEnv ?? process.env;
  const overrides = params?.overrides ?? undefined;
  const sanitized: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    const key = normalizeEnvVarKey(rawKey);
    if (!key) continue;
    if (isBlockedKey(key, BLOCKED_ENV_KEYS, BLOCKED_ENV_PREFIXES)) continue;
    sanitized[key] = value;
  }

  if (overrides) {
    for (const [rawKey, value] of Object.entries(overrides)) {
      if (typeof value !== "string") continue;
      const key = normalizeEnvVarKey(rawKey);
      if (!key) continue;
      if (isBlockedKey(key, BLOCKED_ENV_KEYS, BLOCKED_ENV_PREFIXES)) continue;
      if (isBlockedKey(key, BLOCKED_OVERRIDE_KEYS, BLOCKED_OVERRIDE_PREFIXES)) continue;
      sanitized[key] = value;
    }
  }

  sanitized.DISP8CH_CLI = "1";
  return sanitized;
}
