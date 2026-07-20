export function isDesignStudioSurfaceAssistantRequest(routingMessage: string): boolean {
  return /^Design Studio\s*:/i.test(String(routingMessage || "").trim());
}
