# Memory LanceDB

LanceDB-backed vector memory for high-volume embedding and retrieval workloads.

- LanceDB stores embeddings as Lance columnar format on disk — significantly faster for large collections (>100k vectors) than sqlite-vec.
- Use this backend when the default sqlite-vec backend shows degraded search performance under heavy indexing load.
- All standard memory operations (`memory_search`, `memory_store`, `memory_get`) work identically — the backend switch is transparent.
- Configure `dbPath` in the extension settings to point to the desired LanceDB directory (defaults to `data/lancedb/`).
- For auto-capture mode: the agent automatically stores conversation context chunks without explicit `memory_store` calls.
- For auto-recall mode: relevant memories are automatically injected into context at session start without explicit `memory_search` calls.
- When switching from sqlite-vec to LanceDB: run a memory backfill to migrate existing embeddings to the new backend.
- Monitor embedding batch health via `/api/memory?action=embedding-status` to confirm the LanceDB backend is active.
