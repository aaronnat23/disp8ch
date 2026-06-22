# Feishu Doc

Read, write, and manage Feishu/Lark documents (Docs) using the Feishu Open API.

- Base URL: `https://open.feishu.cn/open-apis`
- Auth: obtain a tenant access token via `POST /auth/v3/tenant_access_token/internal` with `{"app_id": ..., "app_secret": ...}`. Cache the token (valid 2 hours) in memory.
- List documents: `GET /docx/v1/documents` — returns document list for the current user.
- Get document content: `GET /docx/v1/documents/{document_id}/raw_content` — returns Markdown-like plain text.
- Get blocks: `GET /docx/v1/documents/{document_id}/blocks` — returns structured block tree.
- Create a document: `POST /docx/v1/documents` with `{"folder_token": "...", "title": "..."}`.
- Update a block: `PATCH /docx/v1/documents/{document_id}/blocks/{block_id}` with block content.
- Append content: use `POST /docx/v1/documents/{document_id}/blocks/{parent_block_id}/children` to add new blocks.
- Support block types: `paragraph`, `heading1`–`heading9`, `bullet`, `ordered`, `code`, `quote`, `callout`, `table`.
- Always refresh the access token before API calls if it may have expired.
