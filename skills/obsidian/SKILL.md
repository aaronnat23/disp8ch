# Obsidian

Read, write, and search an Obsidian vault using the local REST API plugin or direct file access.

- **Local REST API plugin** (preferred when enabled): use `http_request` to `http://127.0.0.1:27123` with `Authorization: Bearer <OBSIDIAN_API_KEY>`.
  - List files: `GET /vault/` — returns directory tree
  - Read a note: `GET /vault/{path}` — returns Markdown content
  - Create/update a note: `PUT /vault/{path}` with raw Markdown body
  - Search: `POST /search/simple/?query={query}&contextLength=100`
- **Direct file access** (fallback): use `read_file` / `write_file` on the vault directory path configured in settings.
- When writing notes, follow the vault's existing frontmatter convention. Preserve existing YAML frontmatter when updating.
- Use `[[wikilinks]]` syntax for internal links. Use `#tags` for categorization.
- Store vault path and frequently accessed note paths in memory for reuse.
- For daily notes: write to `Daily Notes/YYYY-MM-DD.md` using the date-time node for the current date.
- Always append to existing notes rather than overwriting unless explicitly replacing content.
