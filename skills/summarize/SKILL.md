# Summarize

Concise, structured summarization of URLs, files, YouTube videos, and long documents.

- For URLs: use `http_request` or `browser_action` (navigate + snapshot) to fetch content, then summarize in 3–5 bullet points plus a 1-sentence TL;DR.
- For YouTube: extract the video ID and fetch the transcript via `https://www.youtube.com/watch?v={id}` with `browser_action` snapshot; summarize the transcript.
- For files: use `read_file` to load content; for PDFs use the `document_get` tool if stored in Documents, otherwise `read_file`.
- For long documents (>4000 words): chunk into sections, summarize each section, then produce a final synthesis.
- Always start the summary with: `**Summary of:** <title or URL>`
- Always end with a `**Key Points:**` section as a numbered list (3–7 items).
- If the content has a strong opinion or bias, flag it in a `**Note:**` line at the end.
- Store the summary in memory with type `fact` and the source URL as a tag so it can be recalled later.
