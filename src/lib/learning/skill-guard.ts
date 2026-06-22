/**
 * Security scanner for learned skill content.
 * Uses severity + source trust policy so agent-created skills stay strict
 * without forcing the same verdicts for every source type.
 */

export type SkillGuardSeverity = "low" | "medium" | "high";
export type SkillGuardVerdict = "safe" | "caution" | "dangerous";
export type SkillGuardSourceTrust = "builtin" | "trusted" | "community" | "agent-created";

export type SkillGuardFinding = {
  label: string;
  severity: SkillGuardSeverity;
};

export type SkillGuardReport = {
  safe: boolean;
  verdict: SkillGuardVerdict;
  threats: string[];
  findings: SkillGuardFinding[];
};

const THREAT_PATTERNS: Array<{
  label: string;
  severity: SkillGuardSeverity;
  pattern: RegExp;
}> = [
  // Shell injection / dynamic execution
  { label: "shell-injection:eval", severity: "high", pattern: /\beval\s*\(/ },
  { label: "shell-injection:new-function", severity: "high", pattern: /\bnew\s+Function\s*\(/ },
  { label: "shell-injection:child_process", severity: "high", pattern: /\bchild_process\b/ },
  { label: "shell-injection:require-child_process", severity: "high", pattern: /require\s*\(\s*['"]child_process/ },
  { label: "shell-injection:execSync", severity: "high", pattern: /\bexecSync\b/ },
  { label: "shell-injection:execFile", severity: "high", pattern: /\bexecFile\b/ },
  { label: "shell-injection:spawn", severity: "high", pattern: /\bspawnSync?\b/ },
  { label: "shell-injection:bash-c", severity: "high", pattern: /\bbash\s+-c\b/ },
  { label: "shell-injection:python-os-system", severity: "high", pattern: /\bos\.system\s*\(/ },
  { label: "shell-injection:python-subprocess", severity: "high", pattern: /\bsubprocess\.(run|call|Popen|check_output)\s*\(/ },
  { label: "shell-injection:python-exec", severity: "high", pattern: /\bexec\s*\(/ },
  { label: "shell-injection:python-eval", severity: "high", pattern: /\beval\s*\(/ },
  { label: "shell-injection:python-importlib", severity: "medium", pattern: /\bimportlib\b/ },
  { label: "shell-injection:python-dunder-import", severity: "high", pattern: /__import__\s*\(/ },
  { label: "shell-injection:node-vm", severity: "high", pattern: /\bvm\.runInNewContext\b|\bvm\.runInThisContext\b|\bvm\.Script\b/ },
  { label: "shell-injection:node-require-dynamic", severity: "high", pattern: /\brequire\s*\(\s*\w+\s*\+\s*|require\s*\(\s*`\s*\$/ },
  { label: "shell-injection:sh-c", severity: "high", pattern: /\bsh\s+-c\b|zsh\s+-c\b/ },
  { label: "shell-injection:nohup", severity: "medium", pattern: /\bnohup\b/ },
  { label: "shell-injection:python-compile", severity: "high", pattern: /\bcompile\s*\(\s*['"]|\b__builtins__\b.*\bexec\b/ },

  // Exfiltration / outbound delivery
  { label: "exfiltration:curl-pipe", severity: "high", pattern: /\bcurl\b.*\|/ },
  { label: "exfiltration:wget", severity: "high", pattern: /\bwget\b.*-O/ },
  { label: "exfiltration:fetch-url", severity: "high", pattern: /fetch\s*\(\s*['"]https?:\/\// },
  { label: "exfiltration:xhr", severity: "medium", pattern: /XMLHttpRequest/ },
  { label: "exfiltration:process-env", severity: "high", pattern: /process\.env(?!\s*\.\s*NODE_ENV)/ },
  { label: "exfiltration:read-env-file", severity: "high", pattern: /fs\.readFile[Ss]ync\b.*\.env/ },
  { label: "exfiltration:ssh", severity: "high", pattern: /\bssh\s+[^\s]/ },
  { label: "exfiltration:scp", severity: "high", pattern: /\bscp\s+[^\s]/ },
  { label: "exfiltration:discord-webhook", severity: "high", pattern: /discord\.com\/api\/webhooks/ },
  { label: "exfiltration:telegram-bot", severity: "high", pattern: /api\.telegram\.org\/bot/ },
  { label: "exfiltration:dig", severity: "high", pattern: /\bdig\b.{0,40}\b(?:txt|@|https?:\/\/)/i },
  { label: "exfiltration:nslookup", severity: "high", pattern: /\bnslookup\b.{0,40}\b(?:txt|https?:\/\/)/i },
  { label: "exfiltration:pastebin", severity: "high", pattern: /pastebin\.com/ },
  { label: "exfiltration:ngrok", severity: "high", pattern: /ngrok\.io|ngrok\.com/ },
  { label: "exfiltration:requestbin", severity: "high", pattern: /requestbin\.com|pipedream\.net/ },
  { label: "exfiltration:webhook-site", severity: "high", pattern: /webhook\.site/ },
  { label: "exfiltration:burp-collaborator", severity: "high", pattern: /\.oastify\.com|burpcollaborator\.net/ },
  { label: "exfiltration:dns-tunnel", severity: "high", pattern: /\biodine\b|dns2tcp|dnscat2/i },
  { label: "exfiltration:socat", severity: "high", pattern: /\bsocat\b/ },
  { label: "exfiltration:tcpdump", severity: "high", pattern: /\btcpdump\b.*-w/ },
  { label: "exfiltration:send-email", severity: "medium", pattern: /\bsendmail\b|msmtp|\bmail\s+-s\b/ },
  { label: "exfiltration:gpg-export", severity: "high", pattern: /\bgpg\b.*--export\b|\bgpg\b.*--export-secret/ },
  { label: "exfiltration:zip-secrets", severity: "medium", pattern: /\bzip\s+-r\b.*\b(?:\.env|passwd|shadow|credentials|secrets?)\b/i },
  { label: "exfiltration:tar-secrets", severity: "medium", pattern: /\btar\s+-c[zf]{1,2}\b.*(\.env|credentials|secrets?)/i },

  // Persistence / privilege changes
  { label: "persistence:crontab", severity: "high", pattern: /\bcrontab\b/ },
  { label: "persistence:cron-path", severity: "high", pattern: /\/etc\/cron\.(?:d|daily|hourly|weekly|monthly)\b/ },
  { label: "persistence:systemctl", severity: "high", pattern: /\bsystemctl\s+(?:enable|start|restart)\b/ },
  { label: "persistence:launchctl", severity: "high", pattern: /\blaunchctl\b/ },
  { label: "persistence:schtasks", severity: "high", pattern: /\bschtasks\b/i },
  { label: "persistence:chmod-exec", severity: "medium", pattern: /\bchmod\s+\+x\b/ },

  // Destructive filesystem / recon
  { label: "destructive:rm-rf", severity: "high", pattern: /\brm\s+-[rf]{1,2}\s/ },
  { label: "destructive:rmdir-root", severity: "high", pattern: /\brmdir\s+\// },
  { label: "destructive:mkfs", severity: "high", pattern: /\bmkfs\b/ },
  { label: "destructive:dev-null-overwrite", severity: "high", pattern: />\s*\/dev\/(?!null)/ },
  { label: "destructive:chmod-777", severity: "medium", pattern: /\bchmod\s+777\b/ },
  { label: "destructive:chmod-setuid", severity: "high", pattern: /\bchmod\s+\+s\b/ },
  { label: "destructive:dd", severity: "high", pattern: /\bdd\s+if=/ },
  { label: "destructive:format-drive", severity: "high", pattern: /\bformat\s+[A-Z]:/i },
  { label: "destructive:path-traversal", severity: "medium", pattern: /\.\.[/\\]\.\.[/\\]/ },
  { label: "destructive:truncate-root", severity: "high", pattern: /\btruncate\s+.*\/etc\/|>>\s*\/etc\/passwd/ },
  { label: "destructive:write-etc-passwd", severity: "high", pattern: /[>|]\s*\/etc\/passwd/ },
  { label: "destructive:write-etc-shadow", severity: "high", pattern: /[>|]\s*\/etc\/shadow/ },
  { label: "destructive:write-ssh-authorized-keys", severity: "high", pattern: /[>|]\s*(?:~\/|\.\/|)\s*\.ssh\/authorized_keys/ },
  { label: "destructive:write-cron", severity: "high", pattern: /[>|]\s*\/etc\/crontab/ },
  { label: "destructive:write-sudoers", severity: "high", pattern: /[>|]\s*\/etc\/sudoers/ },
  { label: "destructive:remove-etc", severity: "high", pattern: /\brm\s+-[rf]+\s+\/(?:etc|var|usr|home|root|opt)\b/ },
  { label: "destructive:format-ext4", severity: "high", pattern: /\bmkfs\.ext[234]\b|\bmke2fs\b/ },
  { label: "destructive:remove-boot", severity: "high", pattern: /\brm\s+-[rf]+\s+\/boot\b/ },
  { label: "recon:nmap", severity: "high", pattern: /\bnmap\b/ },
  { label: "recon:netcat", severity: "high", pattern: /\bnc\s+-/ },
  { label: "recon:masscan", severity: "high", pattern: /\bmasscan\b/ },
  { label: "recon:arp-scan", severity: "high", pattern: /\barp-scan\b/ },
  { label: "recon:john-hashcat", severity: "high", pattern: /\bjohn\b.*--wordlist|hashcat\b/ },
  { label: "recon:hydra", severity: "high", pattern: /\bhydra\b.*-l/ },

  // Obfuscation / encoded payloads
  { label: "obfuscation:atob", severity: "medium", pattern: /\batob\s*\(/ },
  { label: "obfuscation:base64-decode", severity: "medium", pattern: /\bbase64\s+-d\b/ },
  { label: "obfuscation:powershell-encoded", severity: "high", pattern: /\bpowershell\b.{0,40}-EncodedCommand\b/i },
  { label: "obfuscation:certutil-decode", severity: "high", pattern: /\bcertutil\b.{0,40}-decode\b/i },
  { label: "obfuscation:xxd", severity: "medium", pattern: /\bxxd\b.*-p\b.*-r\b|xxd\s+-r/ },
  { label: "obfuscation:openssl-enc", severity: "medium", pattern: /\bopenssl\s+enc\b.*-base64/ },
  { label: "obfuscation:tr-subs", severity: "low", pattern: /\btr\s+.*[A-Za-z].*[A-Za-z]/ },
  { label: "obfuscation:rev-shell", severity: "high", pattern: /\/dev\/tcp\/|\/dev\/udp\/|bash\s+-i\s+>&/ },
  { label: "obfuscation:curl-pipe-sh", severity: "high", pattern: /\bcurl\b.{0,20}\|.{0,6}\b(?:sh|bash|zsh|python|perl|ruby)\b/i },
  { label: "obfuscation:wget-pipe-sh", severity: "high", pattern: /\bwget\b.{0,20}\|.{0,6}\b(?:sh|bash|zsh|python|perl|ruby)\b/i },

  // Credential exposure
  { label: "credential:aws-key", severity: "high", pattern: /AKIA[A-Z0-9]{16}/ },
  { label: "credential:aws-secret", severity: "high", pattern: /aws_secret_access_key\s*=\s*['"][^'"]{20,}/ },
  { label: "credential:openai-key", severity: "high", pattern: /sk-[a-zA-Z0-9]{20,}/ },
  { label: "credential:github-token", severity: "high", pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { label: "credential:github-oauth", severity: "high", pattern: /gho_[a-zA-Z0-9]{36}/ },
  { label: "credential:password-literal", severity: "high", pattern: /password\s*[:=]\s*['"][^'"]{4,}/ },
  { label: "credential:secret-literal", severity: "high", pattern: /secret\s*[:=]\s*['"][^'"]{4,}/ },
  { label: "credential:token-literal", severity: "high", pattern: /token\s*[:=]\s*['"][^'"]{4,}/ },
  { label: "credential:private-key-header", severity: "high", pattern: /-----BEGIN\s+(RSA|EC|OPENSSH|PGP)\s+PRIVATE KEY/ },
  { label: "credential:env-hardcoded-key", severity: "high", pattern: /[A-Z_]{8,}_(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*['"][^'"]{8,}/ },
  { label: "credential:azure-storage-key", severity: "high", pattern: /DefaultEndpointsProtocol=https.*AccountKey=[A-Za-z0-9+\/=]{40,}/ },
  { label: "credential:slack-webhook", severity: "high", pattern: /hooks\.slack\.com\/services\/T[A-Z0-9_]+\/B[A-Z0-9_]+\/[A-Za-z0-9]+/ },
  { label: "credential:jwt-token", severity: "high", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "credential:api-key-assign", severity: "high", pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_-]{20,}/i },

  // Defense evasion
  { label: "evasion:uninstall-antivirus", severity: "high", pattern: /\b(rpm\s+-e|dpkg\s+-r|apt-get\s+remove|yum\s+remove)\b.*\b(?:clamav|sophos|eset|trend|crowdstrike|sentinelone|carbon\s*black|defender)\b/i },
  { label: "evasion:stop-service", severity: "high", pattern: /\b(?:systemctl|service)\s+stop\b.*\b(?:auditd|selinux|apparmor|firewalld|ufw|fw)\b/i },
  { label: "evasion:selinux-disable", severity: "high", pattern: /\bsetenforce\s+0\b|selinux\s*=\s*disabled/i },
  { label: "evasion:apparmor-disable", severity: "high", pattern: /\bapparmor_parser\s+-R\b|aa-teardown/i },
  { label: "evasion:iptables-flush", severity: "high", pattern: /\biptables\s+(?:-F|--flush)\b/ },
  { label: "evasion:disable-windows-defender", severity: "high", pattern: /\bSet-MpPreference\b.*-DisableRealtimeMonitoring\s+\$true|\bsc\s+stop\s+WinDefend/i },
  { label: "evasion:unhook-dll", severity: "high", pattern: /\b(?:ntdll\.dll|kernel32\.dll|UnhookWindowsHookEx|ntprotectvirtualmemory)\b/i },
  { label: "evasion:amsi-bypass", severity: "high", pattern: /AmsiScanBuffer|amsiInitFailed|AmsiUtils/i },
  { label: "evasion:etw-patch", severity: "high", pattern: /\bEtwEventWrite\b|EventWriteTransfer/i },
  { label: "evasion:disable-windows-logging", severity: "high", pattern: /\bwevtutil\s+(?:cl|clear-log)/i },
  { label: "evasion:log-clear", severity: "high", pattern: /\b(?:history\s+-c|echo\s*>.*\.bash_history|rm\s+.*history)\b/ },

  // Process injection / memory tampering
  { label: "injection:ptrace", severity: "high", pattern: /\bptrace\b/i },
  { label: "injection:process-hollowing", severity: "high", pattern: /\bCREATE_SUSPENDED\b|NtUnmapViewOfSection/i },
  { label: "injection:createremotethread", severity: "high", pattern: /\bCreateRemoteThread\b/i },
  { label: "injection:dll-injection", severity: "high", pattern: /\b(?:LoadLibraryA|LoadLibraryW|VirtualAllocEx|WriteProcessMemory)\b/i },
  { label: "injection:reflective-dll", severity: "high", pattern: /ReflectiveLoader\b/i },
  { label: "injection:shellcode", severity: "high", pattern: /(?:\\x[0-9a-fA-F]{2}.){20,}|shellcode|msfvenom/i },
  { label: "injection:meterpreter", severity: "high", pattern: /\bmeterpreter\b|msfconsole|msf\d/i },
  { label: "injection:process-migration", severity: "high", pattern: /\bmigrate\b.*\b(?:explorer|lsass|svchost|winlogon)\b/i },

  // Lateral movement
  { label: "lateral:psexec", severity: "high", pattern: /\bpsexec\b/i },
  { label: "lateral:wmic-process-call", severity: "high", pattern: /\bwmic\b.*\bprocess\s+call\s+create\b/i },
  { label: "lateral:winrm", severity: "high", pattern: /\bwinrm\b.*\binvoke\b|Enter-PSSession/i },
  { label: "lateral:impacket", severity: "high", pattern: /\b(?:impacket|secretsdump|samrdump|wmiexec)\b/i },

  // Container / Docker escape
  { label: "container:docker-socket", severity: "high", pattern: /\/var\/run\/docker\.sock/ },
  { label: "container:privileged-escape", severity: "high", pattern: /\bnsenter\b|cgroup.*release_agent|CAP_SYS_ADMIN/i },
  { label: "container:mount-host", severity: "high", pattern: /\bmount\b.*(\/dev\/|\/proc\/|\/sys\/)/ },
  { label: "container:kubectl-exec", severity: "high", pattern: /\bkubectl\s+exec\b/i },
  { label: "container:breakout", severity: "high", pattern: /\/proc\/\d+\/cwd|\/proc\/\d+\/root\// },

  // Supply chain
  { label: "supply-chain:npm-install-url", severity: "high", pattern: /\bnpm\s+(?:install|i)\s+.*(?:https?:|git\+)/i },
  { label: "supply-chain:pip-from-url", severity: "high", pattern: /\bpip\s+install\s+.*https?:\/\//i },
  { label: "supply-chain:typosquatting", severity: "medium", pattern: /\bnpm\s+install.*\b(?:reqests|requesst|rquests|pandas|numppy|beatifulsoup)\b/i },
];

function buildFindings(content: string): SkillGuardFinding[] {
  const findings: SkillGuardFinding[] = [];
  for (const { label, severity, pattern } of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      findings.push({ label, severity });
    }
  }
  return findings;
}

function computeVerdict(findings: SkillGuardFinding[], sourceTrust: SkillGuardSourceTrust): SkillGuardVerdict {
  if (findings.length === 0) return "safe";

  const hasHigh = findings.some((finding) => finding.severity === "high");
  const hasMedium = findings.some((finding) => finding.severity === "medium");

  if (hasHigh) return "dangerous";

  if (sourceTrust === "agent-created" || sourceTrust === "community") {
    return hasMedium ? "dangerous" : "caution";
  }

  return hasMedium ? "caution" : "safe";
}

export function inspectSkillContent(
  content: string,
  options?: { sourceTrust?: SkillGuardSourceTrust },
): SkillGuardReport {
  const sourceTrust = options?.sourceTrust ?? "agent-created";
  const findings = buildFindings(content);
  const verdict = computeVerdict(findings, sourceTrust);
  return {
    safe: verdict === "safe",
    verdict,
    threats: findings.map((finding) => finding.label),
    findings,
  };
}

export function scanSkillContent(content: string): { safe: boolean; threats: string[] } {
  const report = inspectSkillContent(content, { sourceTrust: "agent-created" });
  return {
    safe: report.safe,
    threats: report.threats,
  };
}
