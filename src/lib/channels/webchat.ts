import { logger } from "@/lib/utils/logger";

const log = logger.child("webchat");

export interface WebChatMessage {
  sessionId: string;
  content: string;
  sender: string;
}

export function handleWebChatMessage(message: WebChatMessage): void {
  log.info("WebChat message received", {
    sessionId: message.sessionId,
    contentLength: message.content.length,
  });
}
