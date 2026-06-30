/**
 * Computer-use action policy. Desktop control is higher risk than browser
 * automation, so every action is classified before execution. Observe is
 * read-only but sensitive (it can capture private screen contents). Any action
 * that can submit data, spend money, delete, send messages, enter credentials,
 * change settings, or execute code requires approval.
 */

export type ComputerActionKind =
  | "observe"
  | "list_apps"
  | "launch_app"
  | "focus_app"
  | "click"
  | "type"
  | "set_value"
  | "hotkey"
  | "scroll"
  | "drag"
  | "zoom"
  | "wait"
  | "stop";

export type ComputerActionRisk = "read" | "low" | "moderate" | "high";

export type ComputerActionClassification = {
  kind: ComputerActionKind;
  risk: ComputerActionRisk;
  sensitive: boolean;
  requiresApproval: boolean;
  blocked: boolean;
  reasons: string[];
};

const CREDENTIAL_TEXT = /\b(password|passcode|secret|api[\s_-]?key|token|otp|2fa|seed phrase|ssn|social security)\b/i;
const PAYMENT_TEXT = /\b(card number|cvv|cvc|iban|routing number|account number|pay|payment|transfer|purchase|checkout)\b/i;
const CREDIT_CARD = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/;
const SENSITIVE_APP = /\b(bank|banking|paypal|stripe|wallet|settings|preferences|keychain|password manager|terminal|console)\b/i;
const SUBMIT_KEYS = new Set(["enter", "return"]);
const DESTRUCTIVE_KEYS = new Set(["delete", "backspace"]);
const HARD_BLOCKED_KEY_COMBOS = [
  new Set(["win", "l"]),
  new Set(["ctrl", "alt", "delete"]),
  new Set(["alt", "f4"]),
  new Set(["cmd", "shift", "q"]),
  new Set(["cmd", "option", "backspace"]),
];
const HARD_BLOCKED_TYPED_TEXT = [
  /\bcurl\b[^\r\n|]*\|\s*(?:ba)?sh\b/i,
  /\bwget\b[^\r\n|]*\|\s*(?:ba)?sh\b/i,
  /\brm\s+-[a-z]*r[a-z]*f\s+(?:\/|~)(?:\s|$)/i,
  /:\s*\(\)\s*\{\s*:\|:\s*&\s*\}/,
  /\b(?:format|clear)-disk\b/i,
  /\bshutdown\b[^\r\n]*(?:\/s|-h|now)/i,
];

export type ClassifyInput = {
  kind: ComputerActionKind;
  text?: string;
  keys?: string[];
  target?: string | null;
  appHint?: string | null;
};

export function classifyComputerAction(input: ClassifyInput): ComputerActionClassification {
  const reasons: string[] = [];
  let risk: ComputerActionRisk = "low";
  let sensitive = false;
  let requiresApproval = false;
  let blocked = false;

  const appHint = String(input.appHint || "");
  const target = String(input.target || "");
  const sensitiveApp = SENSITIVE_APP.test(appHint) || SENSITIVE_APP.test(target);
  if (sensitiveApp) {
    reasons.push("Targets a sensitive app/surface (payment, settings, credentials, or a terminal).");
  }

  switch (input.kind) {
    case "observe":
    case "zoom":
      risk = "read";
      sensitive = true;
      reasons.push("Observation may capture private screen contents.");
      break;
    case "list_apps":
      risk = "read";
      sensitive = true;
      reasons.push("Application inventory may reveal private work context.");
      break;
    case "launch_app":
    case "focus_app":
      risk = "moderate";
      requiresApproval = true;
      reasons.push(input.kind === "launch_app" ? "Launching an application changes local desktop state." : "Bringing an application forward can interrupt the user.");
      break;
    case "wait":
      risk = "read";
      break;
    case "scroll":
      risk = "low";
      break;
    case "type": {
      risk = "moderate";
      const text = String(input.text || "");
      if (CREDENTIAL_TEXT.test(text) || CREDIT_CARD.test(text)) {
        risk = "high";
        requiresApproval = true;
        reasons.push("Typing credential or payment-like content.");
      }
      if (PAYMENT_TEXT.test(text)) {
        risk = "high";
        requiresApproval = true;
        reasons.push("Typing payment-related content.");
      }
      if (HARD_BLOCKED_TYPED_TEXT.some((pattern) => pattern.test(text))) {
        risk = "high";
        blocked = true;
        requiresApproval = true;
        reasons.push("Text contains a catastrophic host command that computer use will not enter.");
      }
      if (!input.target) {
        requiresApproval = true;
        reasons.push("Target field is unknown.");
      }
      break;
    }
    case "set_value": {
      risk = "moderate";
      const text = String(input.text || "");
      if (CREDENTIAL_TEXT.test(text) || PAYMENT_TEXT.test(text) || CREDIT_CARD.test(text)) {
        risk = "high";
        requiresApproval = true;
        reasons.push("Setting credential or payment-like content.");
      }
      if (!input.target) {
        requiresApproval = true;
        reasons.push("Target field is unknown.");
      }
      break;
    }
    case "hotkey": {
      risk = "moderate";
      const keys = (input.keys || []).map((k) => {
        const key = k.toLowerCase();
        if (key === "control") return "ctrl";
        if (key === "option") return "alt";
        if (key === "meta" || key === "super" || key === "windows") return "win";
        return key;
      });
      const keySet = new Set(keys);
      if (HARD_BLOCKED_KEY_COMBOS.some((combo) => Array.from(combo).every((key) => keySet.has(key)))) {
        risk = "high";
        blocked = true;
        requiresApproval = true;
        reasons.push("This system-level key combination is always blocked.");
      }
      if (keys.some((k) => SUBMIT_KEYS.has(k))) {
        requiresApproval = true;
        reasons.push("Hotkey can submit a form.");
      }
      if (keys.some((k) => DESTRUCTIVE_KEYS.has(k))) {
        requiresApproval = true;
        reasons.push("Hotkey can delete content.");
      }
      // Modifier combos (Ctrl/Cmd + key) often save/execute.
      if (keys.some((k) => k === "ctrl" || k === "control" || k === "cmd" || k === "meta")) {
        requiresApproval = true;
        reasons.push("Modifier combo can save or execute.");
      }
      break;
    }
    case "click":
    case "drag": {
      risk = "moderate";
      if (!input.target) {
        requiresApproval = true;
        reasons.push("Target is unknown.");
      }
      if (/\b(send|submit|delete|remove|pay|buy|confirm|transfer)\b/i.test(target)) {
        risk = "high";
        requiresApproval = true;
        reasons.push("Action targets a send/submit/delete/pay control.");
      }
      break;
    }
    case "stop":
      risk = "read";
      break;
  }

  if (sensitiveApp) {
    risk = "high";
    requiresApproval = true;
  }

  if (reasons.length === 0) reasons.push("Routine action.");
  return { kind: input.kind, risk, sensitive, requiresApproval, blocked, reasons };
}
