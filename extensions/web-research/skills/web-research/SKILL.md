# Web Research

Structured multi-source web research with citation tracking and synthesis.

- Start every research task by checking memory for prior findings before hitting the web.
- Use `web_search` for general queries; use `http_request` directly for arXiv (`https://export.arxiv.org/api/query?search_query=...`), Semantic Scholar (`https://api.semanticscholar.org/graph/v1/paper/search?query=...`), or CrossRef (`https://api.crossref.org/works?query=...`).
- Collect at least 3 distinct sources before synthesizing an answer. Prefer primary sources over secondary.
- Track source URLs and titles explicitly. Never fabricate citations.
- Deduplicate findings: if two sources say the same thing, merge them and note the agreement.
- For each source, note: (1) what it claims, (2) how strong the evidence is, (3) any conflicting signals.
- Store all research findings to memory with type `fact` or `event` and a confidence score.
- When producing a summary, end with a structured "Sources" section listing title, URL, and reliability rating.
- Flag speculation clearly: prefix any inferred or uncertain claims with "Likely:" or "Uncertain:".
