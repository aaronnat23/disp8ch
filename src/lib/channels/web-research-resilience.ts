/**
 * Web research resilience playbook.
 *
 * Injected for current-web / source-link / public-discussion prompts to
 * help the model pivot when search engines return weak or blocked results.
 */

export const WEB_RESEARCH_RESILIENCE_PLAYBOOK = [
  "Web Research Resilience Playbook:",
  "",
  "1. Use web_search first to find candidate sources.",
  "2. If DuckDuckGo blocks, returns CAPTCHA, or returns too few results (< 2):",
  "   - Try a different query — shorter, with fewer brand-specific terms.",
  "   - Try a different search provider if available (Tavily, Exa, Brave).",
  "   - If no provider option, go directly to primary hubs:",
  "",
  "3. Primary hubs for information:",
  "   - GitHub: search https://github.com/search?q=TERM&type=discussions",
  "   - GitHub issues: https://github.com/OWNER/REPO/issues for specific projects",
  "   - Reddit: https://www.reddit.com/search/?q=TERM",
  "   - Hacker News: https://hn.algolia.com/?q=TERM (Algolia search)",
  "   - Hugging Face: https://huggingface.co/models?search=NAME for model cards",
  "   - npm: https://www.npmjs.com/search?q=TERM for package registries",
  "   - PyPI: https://pypi.org/search/?q=TERM for Python packages",
  "",
  "4. Official docs preference:",
  "   - Prefer official docs, changelogs, release notes, and model cards.",
  "   - Prefer GitHub releases/issues/PRs for project-specific info.",
  "   - Prefer reputable tech publications over social media.",
  "   - Treat community/social-media signal as directional, not authoritative.",
  "",
  "5. Source verification:",
  "   - Search results are hints. Fetch, extract, or open a source before citing it.",
  "   - Do not cite a URL from search snippets alone — label those as search results.",
  "   - Fetch or open at least two materially different sources before concluding.",
  "   - If a page returns CAPTCHA, access-denied, or unusual-traffic, pivot immediately.",
  "   - Do not retry the same blocked URL or search engine more than twice.",
  "",
  "6. When all search paths are blocked or weak:",
  "   - Say which paths were tried and what was returned.",
  "   - Say which information could be verified and which is based on limited evidence.",
  "   - Offer to try again with a narrower query or a specific source type.",
  "   - Do not fabricate source links or claim verification of unfetched URLs.",
  "",
  "7. For GitHub/package research specifically:",
  "   - Go directly to the relevant GitHub org/repo search page when the project is known.",
  "   - Use npm/PyPI search for package versions, download counts, and latest releases.",
  "   - Check the project's own documentation site if one exists.",
].join("\n");
