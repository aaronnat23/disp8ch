// Re-export type for internal use
// The actual WS server runs as server/ws.ts separately

export interface WsMessage {
  type: string;
  data: unknown;
}

export function createWsMessage(type: string, data: unknown): string {
  return JSON.stringify({ type, data });
}
