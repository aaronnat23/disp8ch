export function buildUnknownToolResponse(toolName: string): string {
  return `\`${toolName}\` is not available.

Available tool categories:
- Web/search: web_search, web_extract, web_crawl, fetch_url, browser read-only tools
- Files: list_files, read_file, search_files
- Memory: memory_search, memory_get, memory_store
- Workflows: list/run workflow tools, with confirmation for risky actions
- Boards/tasks: board read tools and task proposal/create tools
- Messaging/channels: send_message, channel status tools

I can help choose the closest available tool if you describe the job.`;
}
