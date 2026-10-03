# web-search (pi extension)

`web_search` tool backed by the Tavily Search API. Key is `TAVILY_SEARCH_API_KEY` in Automic Vault, never in this repo.
On the first search of a session it runs `av inject +TAVILY_SEARCH_API_KEY -- printenv TAVILY_SEARCH_API_KEY` (may show an AV approval prompt) and keeps the key in memory only.
If `TAVILY_SEARCH_API_KEY` is already in the environment, it uses that and skips the vault.
