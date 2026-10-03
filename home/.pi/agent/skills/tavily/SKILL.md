---
name: tavily
description: Tavily CLI (`tvly`) for web jobs the web_search/web_fetch tools can't do - crawl a site, map its URLs, bulk or JS-rendered extraction, deep cited research. For a normal lookup or a single page, use web_search/web_fetch instead.
---

# Tavily CLI

Run via bash. Already installed and authenticated. If you hit an auth or rate-limit error, ask the user to run `tvly login`. Do not run `tvly init`: it reinstalls bulky skills. Add `--json` for structured output. Run `tvly <cmd> --help` for any flag not listed here.

Keep context small: save big output to a file (`-o file` / `--output-dir dir`), then grep or read only what you need.

| Need | Command |
|---|---|
| List URLs on a site (cheap, no content) | `tvly map <url> --limit 100 [--select-paths '/docs/.*'] [--instructions "..."]` |
| Content from many pages | `tvly crawl <url> --max-depth 2 --limit 30 [--select-paths ...] [--instructions "..."] --output-dir ./crawl` |
| Up to 20 known URLs, JS-heavy pages | `tvly extract <url>... [--extract-depth advanced] [--query "..." --chunks-per-source 3] -o out.md` |
| Search with filters web_search lacks | `tvly search "q" [--start-date YYYY-MM-DD] [--include-domains a.com,b.com] [--include-raw-content markdown] [--country X] -o res.json --json` |
| Multi-source cited report (slow, 30-120s, costly) | `tvly research run "question" [--model mini\|pro] [--citation-format numbered] -o report.md` |

Tips:
- Map first, then crawl or extract only the paths you need. Don't crawl a whole site blind.
- `--instructions` (crawl/map) and `--query` (extract) narrow results semantically. Use them to cut noise.
- Use research only when the user wants a synthesized report. For a single fact, use web_search.
