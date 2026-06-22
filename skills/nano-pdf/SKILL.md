# Nano PDF

Extract, analyze, and summarize PDF documents using available tools.

- First check if the PDF is stored in disp8ch Documents: use `documents_search` or `document_get` to retrieve pre-extracted text chunks.
- For local PDF files: use `read_file` — disp8ch's file reader extracts text from PDFs automatically.
- For remote PDFs: use `http_request` to download the file, then use `write_file` to save it locally, then `read_file` to extract text.
- For large PDFs (>50 pages): process in chunks. Ask the user which sections to focus on, or summarize section by section and produce a rolling summary.
- Extraction approach: (1) extract raw text, (2) identify structure (title, authors, abstract, sections), (3) summarize each major section.
- Output format: `**PDF:** {filename}\n**Pages:** ~N\n**Abstract/Summary:** ...\n**Key Sections:**\n- {section}: {summary}`
- For academic papers: extract and cite the bibliography. For contracts/legal docs: flag key clauses (obligations, deadlines, limits).
- Store the extracted summary in memory with the PDF filename as a tag for later recall.
