export type VideoCapabilityStatus =
  | "available"
  | "missing_model"
  | "missing_python_deps"
  | "gpu_unavailable"
  | "disabled_by_policy";

export interface LocalVideoCapabilities {
  caption: VideoCapabilityStatus;
  find: VideoCapabilityStatus;
  speechToText: VideoCapabilityStatus;
}

export function detectLocalVideoCapabilities(): LocalVideoCapabilities {
  const config = readLocalVideoConfig();
  const modelConfigured = config.model !== "";
  const pythonDepsOk = config.pythonDepsOk;
  const enabled = config.enabled;

  if (!enabled) {
    return {
      caption: "disabled_by_policy",
      find: "disabled_by_policy",
      speechToText: "disabled_by_policy",
    };
  }

  if (!modelConfigured) {
    return {
      caption: "missing_model",
      find: "missing_model",
      speechToText: checkSttAvailability(),
    };
  }

  if (!pythonDepsOk) {
    return {
      caption: "missing_python_deps",
      find: "missing_python_deps",
      speechToText: checkSttAvailability(),
    };
  }

  return {
    caption: "available",
    find: "available",
    speechToText: checkSttAvailability(),
  };
}

function readLocalVideoConfig(): { model: string; enabled: boolean; pythonDepsOk: boolean } {
  return {
    model: process.env["LOCAL_VIDEO_MODEL"] ?? "",
    enabled: process.env["LOCAL_VIDEO_MODEL"] !== "",
    pythonDepsOk: false,
  };
}

function checkSttAvailability(): VideoCapabilityStatus {
  try {
    if (typeof window !== "undefined") return "disabled_by_policy";
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const voiceApiFile = join(process.cwd(), "src", "app", "api", "voice", "stt", "route.ts");
    if (existsSync(voiceApiFile)) return "available";
    return "missing_model";
  } catch {
    return "missing_model";
  }
}
