# GitHub Ops

GitHub API operations for issues, pull requests, code search, and repository management.

- Use the `http_request` tool with `https://api.github.com` and `Authorization: Bearer <token>` header for all API calls.
- List issues: `GET /repos/{owner}/{repo}/issues?state=open&per_page=20`
- Create issue: `POST /repos/{owner}/{repo}/issues` with `{"title", "body", "labels"}`
- Search code: `GET /search/code?q={query}+repo:{owner}/{repo}`
- List PRs: `GET /repos/{owner}/{repo}/pulls?state=open`
- Get PR diff: `GET /repos/{owner}/{repo}/pulls/{number}/files`
- For git operations on local repos, use the `git-operation` node or `bash_exec` with `git`.
- Always handle GitHub API rate-limit headers (`X-RateLimit-Remaining`); pause if remaining < 5.
- When creating or updating issues, link related board tasks using the task ID in the issue body.
- Store frequently accessed repo metadata in memory for reuse across sessions.
