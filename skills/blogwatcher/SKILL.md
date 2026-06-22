# Blog Watcher

Monitor RSS/Atom feeds, detect new posts, and deliver digest summaries on a schedule.

- Use `http_request` to fetch RSS/Atom feeds (XML). Parse `<item>` or `<entry>` elements for title, link, pubDate, and description.
- Store the last-seen pubDate or GUID in memory (type `fact`) so subsequent runs only report new posts.
- Compare fetched items against stored GUIDs; only process items not yet seen.
- For each new item: store a summary in memory and optionally send a notification via `send_message` or `send_notification`.
- Digest format: `📰 New posts in [Feed Name]\n1. [Title] — [Link]\n   [1-sentence description]`
- For cron-based monitoring: use a `cron-trigger` node set to your preferred interval (e.g. `0 8 * * *` for 8am daily).
- Combine multiple feeds by running parallel http-request nodes and merging results with an `aggregate` node.
- Flag posts matching keywords (configurable) with a `⚠️` prefix in the digest.
