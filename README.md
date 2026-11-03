# X Bookmarks

All my X (Twitter) bookmarks — organized by topic and searchable. A static site on GitHub Pages, no backend.

## Adding / updating bookmarks

1. Open <https://x.com/i/bookmarks> in Chrome on a computer (logged in), stay at the top.
2. `F12` → **Console** (type `allow pasting` if Chrome asks), paste all of [`export-bookmarks.js`](export-bookmarks.js), press Enter.
3. It auto-scrolls and downloads `bookmarks.json` when it reaches the end (or click **Stop & download**).
4. Replace `bookmarks.json` in this repo with the new file (GitHub → *Add file → Upload files*). The site updates in about a minute.

Re-run it whenever you want to refresh — the new file replaces the old one.
Files from the [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) userscript work too.

## Searching

- Typo-tolerant, prefix matching, ranked results across text, author, quoted tweets, links, hashtags and topics.
- `"exact phrase"`, `-exclude`, `a OR b`
- `from:handle` / `@handle`, `has:image|video|link|quote|thread|long`, `cat:ai`, `site:github.com`
- `after:2024-01-01`, `before:2025`, `year:2023`, `likes:1000`, `lang:hi`
- Keyboard: `/` search · `j`/`k` move · `Enter` open · `c` copy link · `r` random · `?` help

Topics are assigned automatically from keywords — edit [`categories.js`](categories.js) to add or tune them.

> Note: the repo is public, so `bookmarks.json` is visible to anyone with the link. The page asks search engines not to index it.
