# Notion

Read and write Notion pages, databases, and blocks via the Notion API.

- Use `http_request` with `Authorization: Bearer <NOTION_API_KEY>` and `Notion-Version: 2022-06-28` headers for all API calls.
- Base URL: `https://api.notion.com/v1`
- Search pages/databases: `POST /search` with `{"query": "...", "filter": {"value": "page", "property": "object"}}`
- Read a page: `GET /pages/{page_id}`
- Read page content (blocks): `GET /blocks/{page_id}/children`
- Create a page: `POST /pages` with `{"parent": {"database_id": "..."}, "properties": {...}, "children": [...]}`
- Append blocks: `PATCH /blocks/{page_id}/children` with `{"children": [{"type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "..."}}]}}]}`
- Update a page property: `PATCH /pages/{page_id}` with `{"properties": {...}}`
- Store frequently-accessed page IDs and database IDs in memory for reuse.
- When creating rich content, use `callout` blocks for summaries and `toggle` blocks for expandable details.
