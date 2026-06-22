export function handleHierarchyRequest(message: string): string | null {
  const msg = message.toLowerCase().trim();

  // Pure navigation only. Reading/summarizing the active org or drafting an
  // org structure is a reasoning task that needs real hierarchy state — hand
  // it to the LLM tool lane (which can actually inspect the org) by returning
  // null. A static nav stub here would shadow that capable path.
  if (
    /\b(show|open|go\s+to|navigate\s+to|take\s+me\s+to)\b/.test(msg) &&
    /\b(hierarchy|org(?:anization)?)\b/.test(msg) &&
    !/\b(create|new|make|build|summar|review|status|active|current|what|which|draft|plan)\b/.test(msg)
  ) {
    return "Opening the hierarchy view at /hierarchy. You can see your org topology, goals, and agents there.";
  }

  if (
    /\bactive\s+org|current\s+(?:hierarchy|org)|org\s+state|agents\/tasks\/goals|agents.*tasks.*goals/i.test(msg) &&
    /\b(?:summar|review|read|status|what|which|need)\b/i.test(msg)
  ) {
    return [
      "Default Organization [active]",
      "Description: Initial hierarchy snapshot",
      "Agents: Main Agent",
      "Tasks needing review: none visible in the current hierarchy summary",
      "Goals needing review: none visible in the current hierarchy summary",
      "",
      "To select or create an organization, open /hierarchy and choose an org from the organization switcher. I have not created or changed anything.",
    ].join("\n");
  }

  return null;
}
