# Autonomous Researcher

End-to-end research pipeline: scoping, literature review, hypothesis formation, synthesis, empirical validation, and written output.

## Research Pipeline

- Phase 1 — Scope: Decompose the research topic into 3–5 specific sub-questions before starting any search.
- Phase 2 — Literature: Search arXiv, Semantic Scholar, and web sources. Screen for relevance. Target 10–20 sources for a thorough review.
- Phase 3 — Synthesis: Cluster findings by theme. Identify consensus positions, open debates, and knowledge gaps.
- Phase 4 — Hypothesis: Propose 2–3 candidate hypotheses that address a gap. Evaluate feasibility and novelty.
- Phase 5 — Validation (optional): Use the Experiment Loop skill to empirically validate the winning hypothesis — implement, benchmark, keep/discard via git.
- Phase 6 — Output: Write a structured report with: Abstract, Background, Findings, Hypothesis, Experimental Results, Next Steps, References.

## Rules

- Use the `council` node or parallel agents to run competing hypothesis evaluations when multiple stances are plausible.
- Store all intermediate findings in memory with appropriate types (fact, event, profile) so subsequent runs can build on prior work.
- Quality gates: after literature review, verify ≥5 sources found before continuing. After synthesis, verify hypothesis addresses a real gap.
- Cite every factual claim. Use inline references `[Author, Year]` throughout the report body.
- Produce a final `paper_draft.md` artifact saved via `write_file` to `data/workspace/reports/`.
- When the hypothesis involves code changes or performance optimization, combine with the Experiment Loop skill to move from theory to empirical proof.

## API Sources

- arXiv: `https://export.arxiv.org/api/query?search_query={{topic}}&max_results=10`
- Semantic Scholar: `https://api.semanticscholar.org/graph/v1/paper/search?query={{topic}}&limit=10&fields=title,abstract,authors,year`
- CrossRef: `https://api.crossref.org/works?query={{topic}}&rows=10`
- DuckDuckGo: use `web_search` tool for general/current web sources
