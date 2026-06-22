# Feishu Wiki

Read, write, and navigate Feishu/Lark Knowledge Base (Wiki) spaces.

- Auth: use tenant access token (same pattern as feishu-doc). Cache it in memory.
- List wiki spaces: `GET /wiki/v2/spaces` — returns available knowledge base spaces.
- Get a space's root node tree: `GET /wiki/v2/spaces/{space_id}/nodes` — returns top-level wiki nodes.
- Get a specific node: `GET /wiki/v2/spaces/{space_id}/nodes/{node_token}` — returns metadata.
- Get node children: `GET /wiki/v2/spaces/{space_id}/nodes?parent_node_token={token}` — returns child nodes.
- Read wiki page content: use feishu-doc skills on the document_token from the wiki node metadata.
- Create a wiki node: `POST /wiki/v2/spaces/{space_id}/nodes` with `{"obj_type": "doc", "parent_node_token": "...", "node_type": "origin", "origin_node_token": "..."}`.
- Move a node: `POST /wiki/v2/spaces/{space_id}/nodes/{node_token}/move` with `{"target_parent_token": "..."}`.
- Search wiki content: `POST /wiki/v2/spaces/search_wiki` with `{"query": "...", "space_id": "..."}`.
- Store frequently accessed space IDs and node tokens in memory to avoid repeated API traversals.
