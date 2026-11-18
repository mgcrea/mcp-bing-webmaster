# @mgcrea/mcp-bing-webmaster

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Bing Webmaster Tools](https://www.bing.com/webmasters). It lets an agent read a site's Bing
search performance, crawl and index state, sitemaps, inbound links and keyword research, and,
when you allow it, submit URLs and sitemaps.

The server is **read-only by default**. Submitting URLs and every other mutating tool are not
merely refused when writes are off: they are never registered, so an agent cannot call them at
all.

## Features

- **Date windows the API doesn't have.** Bing's `Get*Stats` methods take no date range. Each
  one returns the site's whole history, one row per key per weekly or daily bucket. The server
  filters that history to your window (the last 28 days by default) and aggregates it per query
  or page. Clicks and impressions are summed, and positions are averaged weighted by volume. It
  then sorts and limits the rows, so you get "top 50 queries, last 28 days" rather than the raw
  table.
- **Clean output.** The `{"d": …}` envelope is unwrapped and `__type` tags are dropped.
  `/Date(1316156400000-0700)/` becomes `2011-09-16` for a day bucket, or a full ISO timestamp
  that keeps its offset. The escape hatch gets the same treatment.
- **The site is always explicit.** One API key reaches every site its user verified. Every
  tool therefore takes `site` and resolves it against the sites the key can see. `example.com`,
  `https://www.example.com/` and `sc-domain:example.com` all work. The tool sends Bing the exact
  registered form and stamps it on the response. An unknown or ambiguous site is refused with
  the list of sites the key reaches, so a key from the wrong account shows up immediately
  instead of answering for another tenant.
- **The key stays secret.** Bing puts the API key in the URL. The server never logs, returns or
  embeds a request URL in an error, and it masks the key in any upstream text that echoes it.
- **Safe submissions.** `bing_webmaster_submit_urls` checks every URL before sending any: it
  must be on exactly the site's host (Bing treats `www.`, the apex and subdomains as separate
  sites), on its port, under its path, and carry no credentials. URLs are then normalized and
  deduplicated. The tool uses `SubmitUrl` or `SubmitUrlBatch` as appropriate. A POST is
  never retried automatically, not even after a throttle, because a retry could race the
  model's own retry and spend quota twice. When it times out or gets a 5xx, the error says the
  call may have been applied and which tool to check before resubmitting.
- **Bounded calls.** Every API call finishes within 45 s, retries included, so the answer
  arrives before an MCP client gives up. A `Retry-After` up to 30 s is honoured on GETs. A
  longer one fails at once with "retry after N s" instead of sleeping inside the tool call.
  Cancelling a tool call aborts its request to Bing.
- **Remedies, not just errors.** Bing's `ErrorCode`s (`InvalidApiKey`, `ThrottleUser`,
  `NotAuthorized`, `InvalidUrl`, `NotAllowed`, ...) come back with their name and what to do
  next.

## Security

- **Read-only by default.** `BING_WEBMASTER_ALLOW_WRITES=1` adds the write tools.
  `bing_webmaster_remove_sitemap` also requires `confirm: true`, and so does any non-`Get`
  method called through `bing_webmaster_request`.
- **No runtime dependencies** beyond the MCP SDK and Zod. It uses native `fetch` throughout.
- **Your key** stays in your environment and is sent only to `ssl.bing.com` (or the
  `https://` proxy you configure).
- **Blast radius.** The key can do anything its user can do in Bing Webmaster Tools, on every
  site that user has. With writes off, the server can only read.

## Setup

1. Sign in at <https://www.bing.com/webmasters> with a Microsoft, Google or Facebook account.
2. Add and verify your site. Bing can **import sites from Google Search Console**, already
   verified: Add site → Import from GSC.
3. Open **Settings** (the gear, top right), then **API Access**. Accept the terms, then choose
   **API Key → Generate**.
4. Set `BING_WEBMASTER_API_KEY` and start the server. `bing_webmaster_auth_status` lists the
   sites the key reaches.

There is **one key per user**, and it covers all of that user's sites. Deleting or regenerating
it breaks every app that uses it, so reuse the existing key.

## Configure

Configuration comes from the environment only. The server persists nothing, so there is no
config file.

| Variable                      | Required | Description                                                                      |
| ----------------------------- | -------- | -------------------------------------------------------------------------------- |
| `BING_WEBMASTER_API_KEY`      | yes      | The user's API key (Settings → API Access).                                      |
| `BING_WEBMASTER_ALLOW_WRITES` | no       | `1` registers the write tools and lets `bing_webmaster_request` call non-`Get`s. |
| `BING_WEBMASTER_API_URL`      | no       | Base URL override (a proxy). Must be `https://`, or `http://` on loopback only.  |
| `BING_WEBMASTER_MAX_RETRIES`  | no       | GET retry budget (throttling, 5xx, timeouts). 0-10, default 3. POSTs never.      |
| `BING_WEBMASTER_TIMEOUT_MS`   | no       | Per-attempt timeout, 1000-300000, default 30000. Each call ends within 45 s.     |
| `BING_WEBMASTER_DEBUG`        | no       | `1` logs method names (never URLs) to stderr.                                    |

A bad value never stops the server. An out-of-range number is clamped, an unreadable one
falls back to the default, and a non-https API URL falls back to Bing's own endpoint. Each
case is printed at startup and listed under `config_warnings` in
`bing_webmaster_auth_status`.

```bash
cp .env.example .env
```

## Quotas

- **URL submission** is limited per site, per day and per month, and Bing sets the limit by
  the site's age and standing. `bing_webmaster_get_url_submission_quota` shows what is left.
  `SubmitUrlBatch` accepts at most 500 URLs per call, and no more than the remaining quota.
- **Reads** have no published quota. Bing throttles a key or site that calls too fast
  (`ThrottleUser`, `ThrottleHost`), and the server backs off and retries. Since each
  `Get*Stats` call returns the full history, asking for another window costs one call, not a
  page per day.

## Tools

| Tool                                      | What it does                                                               | Writes |
| ----------------------------------------- | -------------------------------------------------------------------------- | ------ |
| `bing_webmaster_auth_status`              | Configured? Key accepted? Which sites it reaches (count and list), setup   | no     |
| `bing_webmaster_list_sites`               | The key's sites in registered form, verified or not                        | no     |
| `bing_webmaster_get_traffic_summary`      | Clicks and impressions over a window: totals and a daily or weekly series  | no     |
| `bing_webmaster_get_query_stats`          | Top queries over a window: clicks, impressions, CTR, weighted position     | no     |
| `bing_webmaster_get_page_stats`           | Top pages over a window, same metrics                                      | no     |
| `bing_webmaster_get_query_pages`          | For one query, which pages ranked and how                                  | no     |
| `bing_webmaster_get_page_queries`         | For one page, which queries it ranked for                                  | no     |
| `bing_webmaster_get_url_info`             | URL inspection: HTTP status, discovered, last crawled, size, anchors       | no     |
| `bing_webmaster_get_fetched_url`          | A live Bingbot fetch's result (status, headers, HTML preview), or the list | no     |
| `bing_webmaster_get_crawl_stats`          | Crawl totals over a window; pages in index and inbound links first → last  | no     |
| `bing_webmaster_get_crawl_issues`         | URLs with crawl problems, counted by issue type, most-linked first         | no     |
| `bing_webmaster_list_sitemaps`            | Submitted sitemaps and feeds with status and URL counts                    | no     |
| `bing_webmaster_get_sitemap`              | One sitemap; for an index, its child sitemaps                              | no     |
| `bing_webmaster_get_link_counts`          | The site's pages with inbound links, and how many (paged)                  | no     |
| `bing_webmaster_get_url_links`            | Who links to one page, with anchor text (paged)                            | no     |
| `bing_webmaster_get_keyword_stats`        | Keyword research: weekly Bing search volume for a keyword in a market      | no     |
| `bing_webmaster_get_related_keywords`     | Keyword research: related keywords and their volume over a window          | no     |
| `bing_webmaster_get_url_submission_quota` | URLs the site may still submit today and this month                        | no     |
| `bing_webmaster_request`                  | Any API method by name: `Get*` always, others only with writes + `confirm` | gated  |
| `bing_webmaster_submit_urls`              | Submit 1-500 of the site's URLs for crawling (spends quota)                | yes    |
| `bing_webmaster_submit_sitemap`           | Submit a sitemap or feed                                                   | yes    |
| `bing_webmaster_remove_sitemap`           | Remove a sitemap; requires `confirm: true`                                 | yes    |
| `bing_webmaster_fetch_url`                | Ask Bingbot to fetch a page now (read the result with `get_fetched_url`)   | yes    |

Some methods have no tool on purpose and are reachable through `bing_webmaster_request`:
blocked URLs, site roles, crawl settings, site moves, query parameters, deep links,
`AddSite`/`VerifySite`/`RemoveSite`, `SubmitContent`, `GetKeyword`, `GetUrlTrafficInfo` and
`GetChildrenUrlInfo`.

### Things worth knowing

- **Buckets are kept whole.** A weekly bucket counts when its date falls inside the window,
  even if its week straddles an edge. Every windowed answer reports `buckets` (the first and
  last bucket dates kept, and how many) so "28 days" never quietly means four whole weeks.
- **The newest days are usually empty.** Bing's search data lags a few days, and query and
  page stats are updated weekly. When a window has no rows, the answer gives Bing's actual data
  range rather than reporting zero traffic.
- **Top queries and pages only.** Totals from `get_query_stats` and `get_page_stats` are
  smaller than the site's. `get_traffic_summary` has the site totals.
- **Traffic includes every vertical.** Since 2023-03-24, Bing counts web, Copilot/chat, news,
  images, videos and the knowledge panel together.
- **Keyword research is Bing-wide**, not your site's traffic. `impressions` counts searches
  for exactly the keyword; `broad_impressions` adds close variants. A low-volume keyword returns
  no rows.
- **`site` must already be in Bing Webmaster Tools.** Data calls on an unverified site fail
  with `NotAuthorized`. `bing_webmaster_list_sites` shows the verification codes.
- **Known gap: the AI Performance report** (Copilot citations, preview since Feb 2026) has no
  API. It is only available as a CSV export from the dashboard.
- IndexNow is deliberately not part of this server. Wire it into your deploy instead.

## Verify live

This server was built against the documentation, with no API key, so none of the following
has been seen on the wire yet. Each item is handled defensively, but check it on the first
real calls with `live_call.mjs`:

- **The `{"d": …}` envelope** on every answer, and `{"d": null}` from the void methods
  (`SubmitUrl`, `SubmitFeed`, ...). An unwrapped payload is tolerated.
- **Dates**: `/Date(ms-0700)/` and `/Date(ms)/`, whether day buckets are local midnight, and
  `/Date(-62135596800000)/` meaning "no date".
- **Bucket size and history depth** of `GetQueryStats`, `GetPageStats`, `GetQueryPageStats`,
  `GetPageQueryStats` (documented as updated weekly), `GetRankAndTrafficStats` and
  `GetCrawlStats` (updated daily, about six months). Every answer reports the `granularity` it
  detected.
- **Which field holds the page URL** in `GetPageStats` and `GetQueryPageStats` rows. The docs
  suggest `Query`, and the server takes `Page` or `Url` first if Bing sends one.
- **Error bodies**: `{"ErrorCode": n, "Message": "..."}` with HTTP 400, and which code a spent
  URL quota returns (assumed `NotAllowed`).
- **String parameters sent unquoted** (`?page=https://…`). The docs' JSON samples JSON-quote
  some of them (`?page="https:\/\/…"`). WCF accepts both forms in principle.
- **`GetRelatedKeywords` dates** sent as `YYYY-MM-DD`. The docs give no sample for this
  method's `DateTime` parameters.
- **`DailyQuota` / `MonthlyQuota`**: whether they are what is left or the limit. The sample
  (5 per day, 24 per month) suggests what is left.
- **The `Issues` flags** in `GetCrawlIssues`: a number in JSON, names in the old POX format.
  Both are decoded.
- **Positions of 0 or -1** for "no position", which are excluded from averages.

```bash
node ../.studio/mcp-template/skill/scripts/live_call.mjs --server . --env-file .env --list \
  '[["bing_webmaster_auth_status"], ["bing_webmaster_get_query_stats", {"site": "example.com", "limit": 5}]]'
```

## Quick start

```bash
pnpm install
pnpm build
```

Then copy `.mcp.json.example` to `.mcp.json` and fill it in.

### Inspect the tools

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/cli.js 2>/dev/null | jq -r '.result.tools[]?.name'
```

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest
pnpm typecheck
pnpm lint
pnpm format
```

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm + GHCR from the tag
```

## License

MIT
