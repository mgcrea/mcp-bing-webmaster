// The context-window layer.
//
// Bing answers in WCF's JSON dialect: every payload sits in a `{"d": ...}`
// envelope, every object carries a `"__type": "QueryStats:#Microsoft.Bing..."`
// tag, and every date is `"/Date(1316156400000-0700)/"`. None of that is worth a
// token to a model, so it is unwrapped, stripped and converted here, once, for
// every response — the escape hatch included.
//
// The bigger job is the statistics. The Get*Stats methods take no date range:
// each returns the site's whole history (weekly or daily buckets, one row per
// key per bucket), and a busy site's GetQueryStats is thousands of rows. The
// tools filter by date, aggregate per key over the window, sort and cut here,
// so a model gets "top 50 queries, last 28 days" instead of the raw table.
//
// These shapes are NOT live-verified (no key existed when this was written).
// Everything below reads defensively: an unwrapped payload, a missing field, a
// date already in ISO form, a flags enum sent by name instead of number.

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- dates ------------------------------------------------------------------

/**
 * `/Date(ms)/` or `/Date(ms±HHMM)/`. The milliseconds are always the UTC
 * instant; the offset only says which local time the value was written in
 * (Bing writes Pacific time). JSON decoding has already turned `\/` into `/`,
 * but a double-escaped copy is tolerated too.
 */
const WCF_DATE = /^\\?\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\\?\/$/;

/** DateTime.MinValue, which WCF writes for "no date". Anything before the epoch is treated the same. */
export const WCF_MIN_DATE_MS = -62135596800000;

export type WcfDate = { ms: number; offsetMinutes: number | undefined };

/**
 * Parse a WCF date. Returns undefined when the string is not one at all, and
 * null when it is one that means "no date" (DateTime.MinValue, or anything
 * negative: nothing in Bing's data predates 1970).
 */
export const parseWcfDate = (value: string): WcfDate | null | undefined => {
  const m = WCF_DATE.exec(value);
  if (!m) return undefined;
  const ms = Number(m[1]);
  if (!Number.isSafeInteger(ms) || ms < 0 || Number.isNaN(new Date(ms).getTime())) return null;
  if (m[2] === undefined) return { ms, offsetMinutes: undefined };
  const sign = m[2] === "-" ? -1 : 1;
  return { ms, offsetMinutes: sign * (Number(m[3]) * 60 + Number(m[4])) };
};

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * Render a parsed WCF date as ISO 8601, keeping the offset Bing wrote it in, so
 * the local calendar date stays the first ten characters:
 * `/Date(1316156400000-0700)/` → `2011-09-16`, because that instant is local
 * midnight; a non-midnight value keeps its time and offset, e.g.
 * `2011-09-06T16:02:02.338-07:00`. Without an offset it is UTC (`…Z`).
 *
 * Local midnight collapses to the bare date because that is what a day bucket
 * is, and a true midnight timestamp loses nothing by it.
 */
export const formatWcfDate = (date: WcfDate): string => {
  const offset = date.offsetMinutes ?? 0;
  const local = new Date(date.ms + offset * 60_000);
  const day = `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const h = local.getUTCHours();
  const min = local.getUTCMinutes();
  const s = local.getUTCSeconds();
  const ms = local.getUTCMilliseconds();
  if (h === 0 && min === 0 && s === 0 && ms === 0) return day;
  const time = `${pad(h)}:${pad(min)}:${pad(s)}${ms ? `.${pad(ms, 3)}` : ""}`;
  if (date.offsetMinutes === undefined) return `${day}T${time}Z`;
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${day}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

/** Convert one string if it is a WCF date; leave anything else untouched. */
export const convertDate = (value: string): string | null => {
  const parsed = parseWcfDate(value);
  if (parsed === undefined) return value;
  return parsed === null ? null : formatWcfDate(parsed);
};

/**
 * The calendar day a normalized value falls on: the first ten characters of
 * the ISO form above, which is the local date Bing meant. Accepts a raw WCF
 * date too, and an ISO string Bing might send one day instead.
 */
export const toDay = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const converted = convertDate(value);
  if (typeof converted !== "string") return undefined;
  return /^\d{4}-\d{2}-\d{2}/.test(converted) ? converted.slice(0, 10) : undefined;
};

// ---- the envelope -------------------------------------------------------------

/** `{"d": payload}` → payload. An already-unwrapped payload passes through. */
export const unwrap = (body: unknown): unknown =>
  isRecord(body) && "d" in body && Object.keys(body).every((k) => k === "d" || k === "__type")
    ? body.d
    : body;

/** Strip `__type` everywhere and convert every WCF date, recursively. */
export const normalize = (value: unknown): unknown => {
  if (typeof value === "string") return convertDate(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (isRecord(value)) {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "__type") continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
};

/** What every response goes through before anything else looks at it. */
export const normalizeResponse = (body: unknown): unknown => normalize(unwrap(body));

// ---- small readers ------------------------------------------------------------

const num = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Drop undefined (and null) fields, so nothing spends tokens on them. */
export const omitEmpty = <T extends Rec>(obj: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<T>;

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

export const ctrOf = (clicks: number, impressions: number): number | undefined =>
  impressions > 0 ? round(clicks / impressions, 4) : undefined;

// ---- date windows -------------------------------------------------------------

export type DateWindow = { start: string; end: string };

const DAY_MS = 86_400_000;

export const dayToMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const msToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => msToDay(dayToMs(day) + n * DAY_MS);

/**
 * Resolve optional start/end dates into an inclusive window. Defaults to the
 * last `defaultDays` days ending on `end_date` (today, UTC, when omitted).
 */
export const resolveWindow = (
  args: { start_date?: string | undefined; end_date?: string | undefined },
  today: string,
  defaultDays: number,
): DateWindow => {
  const end = args.end_date ?? today;
  const start = args.start_date ?? addDays(end, -(defaultDays - 1));
  return { start, end };
};

export const inWindow = (day: string, window: DateWindow): boolean =>
  day >= window.start && day <= window.end;

export type Granularity = "daily" | "weekly" | "irregular";

/** Infer the bucket size from the dates present: the median gap, in days. */
export const detectGranularity = (days: string[]): Granularity | undefined => {
  const unique = [...new Set(days)].toSorted();
  if (unique.length < 2) return undefined;
  const gaps: number[] = [];
  for (let i = 1; i < unique.length; i += 1) {
    gaps.push(
      Math.round((dayToMs(unique[i] as string) - dayToMs(unique[i - 1] as string)) / DAY_MS),
    );
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] as number;
  if (median === 1) return "daily";
  if (median === 7) return "weekly";
  return "irregular";
};

/** Monday of the ISO week containing `day`. */
export const weekStart = (day: string): string => {
  const ms = dayToMs(day);
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  return msToDay(ms - ((dow + 6) % 7) * DAY_MS);
};

const dataRange = (days: string[]): { first: string; last: string } | undefined => {
  if (days.length === 0) return undefined;
  const sorted = days.toSorted();
  return { first: sorted[0] as string, last: sorted[sorted.length - 1] as string };
};

/**
 * Buckets are kept whole: a weekly bucket counts when its date falls inside
 * the window, even if the week it covers straddles an edge. So every windowed
 * answer says which buckets it kept, and the rule, rather than letting
 * "28 days" quietly mean four whole weeks.
 */
export const BUCKET_RULE =
  "A bucket is kept whole when its date falls inside the window, so the figures cover " +
  "buckets.first to the end of the bucket dated buckets.last, not exactly start_date..end_date.";

export const bucketsKept = (
  days: string[],
  granularity: Granularity | undefined,
): Rec | undefined => {
  const unique = [...new Set(days)].toSorted();
  if (unique.length === 0) return undefined;
  return {
    first: unique[0],
    last: unique[unique.length - 1],
    count: unique.length,
    ...(granularity !== undefined && granularity !== "daily" ? { rule: BUCKET_RULE } : {}),
  };
};

/** The note that stops an empty window from reading as "no traffic". */
const emptyWindowNote = (window: DateWindow, range: { first: string; last: string } | undefined) =>
  range === undefined
    ? "Bing returned no rows at all for this site: it may be new, or have no search traffic yet."
    : `No rows fall inside ${window.start}..${window.end}. Bing has data from ${range.first} to ` +
      `${range.last}; widen start_date/end_date to cover it.`;

// ---- search performance (QueryStats rows) -------------------------------------

export type StatsRow = {
  key: string;
  day: string | undefined;
  impressions: number;
  clicks: number;
  position: number | undefined;
  clickPosition: number | undefined;
};

/**
 * Read QueryStats rows. `keyOf` picks the key: `Query` holds the query text in
 * GetQueryStats and GetPageQueryStats, and — despite its name — the page URL in
 * GetPageStats and GetQueryPageStats.
 */
export const readStatsRows = (payload: unknown, keyOf: (row: Rec) => unknown): StatsRow[] =>
  asArray(payload)
    .filter(isRecord)
    .map((row) => ({
      key: str(keyOf(row)) ?? "",
      day: toDay(row.Date),
      impressions: num(row.Impressions) ?? 0,
      clicks: num(row.Clicks) ?? 0,
      position: num(row.AvgImpressionPosition),
      clickPosition: num(row.AvgClickPosition),
    }));

export type StatsSortBy = "clicks" | "impressions" | "ctr" | "position";

export type AggregatedKey = {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | undefined;
  position: number | undefined;
  clickPosition: number | undefined;
};

/**
 * Sum clicks and impressions per key, and average the positions weighted by
 * the volume each bucket carried: impression position by impressions, click
 * position by clicks. A plain mean would let a week with 2 impressions at
 * position 80 count as much as a week with 2,000 at position 3.
 *
 * Positions of 0 or below are Bing's "no position" and carry no weight.
 */
export const aggregateByKey = (rows: StatsRow[]): AggregatedKey[] => {
  type Acc = {
    clicks: number;
    impressions: number;
    posW: number;
    posN: number;
    cpW: number;
    cpN: number;
  };
  const acc = new Map<string, Acc>();
  for (const row of rows) {
    const a = acc.get(row.key) ?? { clicks: 0, impressions: 0, posW: 0, posN: 0, cpW: 0, cpN: 0 };
    a.clicks += row.clicks;
    a.impressions += row.impressions;
    if (row.position !== undefined && row.position > 0 && row.impressions > 0) {
      a.posW += row.position * row.impressions;
      a.posN += row.impressions;
    }
    if (row.clickPosition !== undefined && row.clickPosition > 0 && row.clicks > 0) {
      a.cpW += row.clickPosition * row.clicks;
      a.cpN += row.clicks;
    }
    acc.set(row.key, a);
  }
  return [...acc.entries()].map(([key, a]) => ({
    key,
    clicks: a.clicks,
    impressions: a.impressions,
    ctr: ctrOf(a.clicks, a.impressions),
    position: a.posN > 0 ? round(a.posW / a.posN, 1) : undefined,
    clickPosition: a.cpN > 0 ? round(a.cpW / a.cpN, 1) : undefined,
  }));
};

/** Best first: most clicks / impressions / highest CTR, or the lowest (best) position. */
export const sortKeys = (keys: AggregatedKey[], sortBy: StatsSortBy): AggregatedKey[] => {
  const metric = (k: AggregatedKey): number | undefined =>
    sortBy === "position" ? k.position : sortBy === "ctr" ? k.ctr : k[sortBy];
  const direction = sortBy === "position" ? 1 : -1;
  return keys.toSorted((a, b) => {
    const ma = metric(a);
    const mb = metric(b);
    if (ma === undefined && mb !== undefined) return 1;
    if (mb === undefined && ma !== undefined) return -1;
    if (ma !== undefined && mb !== undefined && ma !== mb) return (ma - mb) * direction;
    if (a.impressions !== b.impressions) return b.impressions - a.impressions;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
};

export type StatsOptions = {
  window: DateWindow;
  sortBy: StatsSortBy;
  limit: number;
  contains?: string | undefined;
  /** What the key is called in the output: `query` or `page`. */
  keyName: "query" | "page";
};

/** The whole search-performance pipeline: window → aggregate → filter → sort → cut. */
export const summarizeStats = (rows: StatsRow[], opts: StatsOptions): Rec => {
  const dated = rows.filter((r) => r.day !== undefined);
  const days = dated.map((r) => r.day as string);
  const range = dataRange(days);
  // If Bing ever sends rows without a Date, the window cannot apply. Say so
  // rather than return nothing.
  const undatedOnly = dated.length === 0 && rows.length > 0;
  const windowed = undatedOnly ? rows : dated.filter((r) => inWindow(r.day as string, opts.window));
  let keys = aggregateByKey(windowed);
  const needle = opts.contains?.toLowerCase();
  if (needle) keys = keys.filter((k) => k.key.toLowerCase().includes(needle));
  const sorted = sortKeys(keys, opts.sortBy);
  const top = sorted.slice(0, opts.limit);
  const clicks = keys.reduce((s, k) => s + k.clicks, 0);
  const impressions = keys.reduce((s, k) => s + k.impressions, 0);
  return omitEmpty({
    window: { start_date: opts.window.start, end_date: opts.window.end },
    granularity: detectGranularity(days),
    data_range: range,
    buckets: undatedOnly
      ? undefined
      : bucketsKept(
          windowed.map((r) => r.day as string),
          detectGranularity(days),
        ),
    totals: omitEmpty({ clicks, impressions, ctr: ctrOf(clicks, impressions) }),
    total_keys: keys.length,
    returned: top.length,
    ...(sorted.length > top.length
      ? {
          truncated: true,
          note: `Showing the top ${top.length} of ${sorted.length} by ${opts.sortBy}; raise limit for more.`,
        }
      : {}),
    ...(undatedOnly
      ? {
          warning:
            "Bing's rows carry no Date, so the date window could not be applied: these are all-time figures.",
        }
      : windowed.length === 0
        ? { note: emptyWindowNote(opts.window, range) }
        : {}),
    rows: top.map((k) =>
      omitEmpty({
        [opts.keyName]: k.key,
        clicks: k.clicks,
        impressions: k.impressions,
        ctr: k.ctr,
        position: k.position,
        click_position: k.clickPosition,
      }),
    ),
  });
};

// ---- traffic summary (RankAndTrafficStats rows) ---------------------------------

export type TrafficRow = { day: string | undefined; clicks: number; impressions: number };

export const readTrafficRows = (payload: unknown): TrafficRow[] =>
  asArray(payload)
    .filter(isRecord)
    .map((row) => ({
      day: toDay(row.Date),
      clicks: num(row.Clicks) ?? 0,
      impressions: num(row.Impressions) ?? 0,
    }));

export type TrafficInterval = "native" | "week";

export const summarizeTraffic = (
  rows: TrafficRow[],
  window: DateWindow,
  interval: TrafficInterval,
): Rec => {
  const dated = rows.filter((r) => r.day !== undefined) as (TrafficRow & { day: string })[];
  const days = dated.map((r) => r.day);
  const range = dataRange(days);
  const windowed = dated.filter((r) => inWindow(r.day, window));
  const buckets = new Map<string, { clicks: number; impressions: number }>();
  for (const row of windowed) {
    const key = interval === "week" ? weekStart(row.day) : row.day;
    const b = buckets.get(key) ?? { clicks: 0, impressions: 0 };
    b.clicks += row.clicks;
    b.impressions += row.impressions;
    buckets.set(key, b);
  }
  const series = [...buckets.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, b]) =>
      omitEmpty({
        date,
        clicks: b.clicks,
        impressions: b.impressions,
        ctr: ctrOf(b.clicks, b.impressions),
      }),
    );
  const clicks = windowed.reduce((s, r) => s + r.clicks, 0);
  const impressions = windowed.reduce((s, r) => s + r.impressions, 0);
  return omitEmpty({
    window: { start_date: window.start, end_date: window.end },
    granularity: detectGranularity(days),
    interval: interval === "week" ? "week (Monday start)" : "as reported",
    data_range: range,
    buckets: bucketsKept(
      windowed.map((r) => r.day),
      detectGranularity(days),
    ),
    totals: omitEmpty({ clicks, impressions, ctr: ctrOf(clicks, impressions) }),
    ...(windowed.length === 0 ? { note: emptyWindowNote(window, range) } : {}),
    series,
  });
};

// ---- crawl statistics (CrawlStats rows) -------------------------------------------

/** Per-bucket counters: these add up over a window. */
const CRAWL_FLOWS: [string, string][] = [
  ["CrawledPages", "crawled_pages"],
  ["CrawlErrors", "crawl_errors"],
  ["Code2xx", "code_2xx"],
  ["Code301", "code_301"],
  ["Code302", "code_302"],
  ["Code4xx", "code_4xx"],
  ["Code5xx", "code_5xx"],
  ["AllOtherCodes", "all_other_codes"],
  ["BlockedByRobotsTxt", "blocked_by_robots_txt"],
  ["ContainsMalware", "contains_malware"],
  ["ConnectionTimeout", "connection_timeout"],
  ["DnsFailures", "dns_failures"],
];

/** Snapshots, not counters: summing InIndex over 28 days means nothing, so report first/last. */
const CRAWL_LEVELS: [string, string][] = [
  ["InIndex", "in_index"],
  ["InLinks", "in_links"],
];

export const summarizeCrawlStats = (
  payload: unknown,
  window: DateWindow,
  includeSeries: boolean,
): Rec => {
  const rows = asArray(payload)
    .filter(isRecord)
    .map((row) => ({ day: toDay(row.Date), row }))
    .filter((r): r is { day: string; row: Rec } => r.day !== undefined)
    .toSorted((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const days = rows.map((r) => r.day);
  const range = dataRange(days);
  const windowed = rows.filter((r) => inWindow(r.day, window));
  const totals: Rec = {};
  for (const [from, to] of CRAWL_FLOWS) {
    totals[to] = windowed.reduce((s, r) => s + (num(r.row[from]) ?? 0), 0);
  }
  const levels: Rec = {};
  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  if (first && last) {
    for (const [from, to] of CRAWL_LEVELS) {
      const a = num(first.row[from]);
      const b = num(last.row[from]);
      if (a === undefined && b === undefined) continue;
      levels[to] = omitEmpty({
        first: a,
        last: b,
        change: a !== undefined && b !== undefined ? b - a : undefined,
      });
    }
  }
  return omitEmpty({
    window: { start_date: window.start, end_date: window.end },
    granularity: detectGranularity(days),
    data_range: range,
    buckets: bucketsKept(
      windowed.map((r) => r.day),
      detectGranularity(days),
    ),
    totals: windowed.length > 0 ? totals : undefined,
    index: Object.keys(levels).length > 0 ? levels : undefined,
    ...(windowed.length === 0 ? { note: emptyWindowNote(window, range) } : {}),
    series: includeSeries
      ? windowed.map((r) => {
          const out: Rec = { date: r.day };
          for (const [from, to] of [...CRAWL_FLOWS, ...CRAWL_LEVELS]) {
            const v = num(r.row[from]);
            if (v !== undefined) out[to] = v;
          }
          return out;
        })
      : undefined,
  });
};

// ---- crawl issues -----------------------------------------------------------------

/** UrlWithCrawlIssues.CrawlIssues, a [Flags] enum: one URL can carry several. */
export const CRAWL_ISSUE_FLAGS: [number, string][] = [
  [1, "Code301"],
  [2, "Code302"],
  [4, "Code4xx"],
  [8, "Code5xx"],
  [16, "BlockedByRobotsTxt"],
  [32, "ContainsMalware"],
  [64, "ImportantUrlBlockedByRobotsTxt"],
  [128, "DnsErrors"],
  [256, "TimeOutErrors"],
];

export const CRAWL_ISSUE_NAMES = CRAWL_ISSUE_FLAGS.map(([, name]) => name) as [string, ...string[]];

/** Decode the flags: a number (JSON), or names ("Code4xx, Code5xx", as POX sent them). */
export const decodeCrawlIssues = (value: unknown): string[] => {
  if (typeof value === "number") {
    const names = CRAWL_ISSUE_FLAGS.filter(([bit]) => (value & bit) !== 0).map(([, n]) => n);
    const known = CRAWL_ISSUE_FLAGS.reduce((m, [bit]) => m | bit, 0);
    if ((value & ~known) !== 0) names.push(`Unknown(${value & ~known})`);
    return names;
  }
  if (typeof value === "string") {
    return value.split(/[\s,|]+/).filter((s) => s !== "" && s !== "None");
  }
  return [];
};

export const summarizeCrawlIssues = (
  payload: unknown,
  opts: { issue?: string | undefined; limit: number },
): Rec => {
  const all = asArray(payload)
    .filter(isRecord)
    .map((row) =>
      omitEmpty({
        url: str(row.Url),
        http_code: num(row.HttpCode),
        issues: decodeCrawlIssues(row.Issues),
        in_links: num(row.InLinks),
      }),
    );
  const byIssue: Record<string, number> = {};
  for (const row of all) {
    for (const issue of row.issues ?? []) byIssue[issue] = (byIssue[issue] ?? 0) + 1;
  }
  const filtered = opts.issue ? all.filter((r) => r.issues?.includes(opts.issue as string)) : all;
  // Most-linked first: a broken page many others point to costs the most.
  const sorted = filtered.toSorted((a, b) => (b.in_links ?? 0) - (a.in_links ?? 0));
  const urls = sorted.slice(0, opts.limit);
  return omitEmpty({
    total_urls: all.length,
    by_issue: byIssue,
    ...(opts.issue ? { filter: opts.issue, matching_urls: filtered.length } : {}),
    returned: urls.length,
    ...(sorted.length > urls.length
      ? {
          truncated: true,
          note: `Showing ${urls.length} of ${sorted.length}, most-linked first; raise limit or filter by issue.`,
        }
      : {}),
    urls,
  });
};

// ---- single objects ---------------------------------------------------------------

export type Site = {
  url: string;
  verified: boolean | undefined;
  authenticationCode: string | undefined;
  dnsVerificationCode: string | undefined;
};

export const readSites = (payload: unknown): Site[] =>
  asArray(payload)
    .filter(isRecord)
    .map((row) => ({
      url: str(row.Url) ?? "",
      verified: bool(row.IsVerified),
      authenticationCode: str(row.AuthenticationCode),
      dnsVerificationCode: str(row.DnsVerificationCode),
    }))
    .filter((s) => s.url !== "");

/** The verification codes only matter for a site still to verify, so only those carry them. */
export const shapeSite = (site: Site): Rec =>
  omitEmpty({
    url: site.url,
    verified: site.verified,
    ...(site.verified === false
      ? {
          verification: omitEmpty({
            meta_tag_or_xml_file_code: site.authenticationCode,
            dns_cname: site.dnsVerificationCode,
          }),
        }
      : {}),
  });

export const shapeUrlInfo = (payload: unknown): Rec => {
  const p = isRecord(payload) ? payload : {};
  return omitEmpty({
    url: str(p.Url),
    // Bing answers 0 for pages it has crawled and indexed (seen live on
    // 2026-11-18 for two 200 pages): it means "not reported", not a status.
    http_status: num(p.HttpStatus) || undefined,
    is_page: bool(p.IsPage),
    discovery_date: str(p.DiscoveryDate),
    last_crawled_date: str(p.LastCrawledDate),
    document_size: num(p.DocumentSize),
    anchor_count: num(p.AnchorCount),
    total_child_url_count: num(p.TotalChildUrlCount),
  });
};

export const shapeFeed = (row: unknown): Rec => {
  const p = isRecord(row) ? row : {};
  return omitEmpty({
    url: str(p.Url),
    type: str(p.Type) ?? num(p.Type),
    status: str(p.Status) ?? num(p.Status),
    url_count: num(p.UrlCount),
    file_size: num(p.FileSize),
    compressed: bool(p.Compressed),
    submitted: str(p.Submitted),
    last_crawled: str(p.LastCrawled),
  });
};

export const shapeFeeds = (payload: unknown, limit: number): Rec => {
  const feeds = asArray(payload).map(shapeFeed);
  const top = feeds.slice(0, limit);
  return omitEmpty({
    total: feeds.length,
    returned: top.length,
    ...(feeds.length > top.length
      ? { truncated: true, note: `Showing ${top.length} of ${feeds.length}; raise limit for more.` }
      : {}),
    sitemaps: top,
  });
};

export const shapeLinkCounts = (payload: unknown, page: number): Rec => {
  const p = isRecord(payload) ? payload : {};
  const totalPages = num(p.TotalPages);
  return omitEmpty({
    page,
    total_pages: totalPages,
    ...(totalPages !== undefined && page + 1 < totalPages ? { next_page: page + 1 } : {}),
    links: asArray(p.Links)
      .filter(isRecord)
      .map((l) => omitEmpty({ url: str(l.Url), inbound_links: num(l.Count) })),
  });
};

export const shapeUrlLinks = (payload: unknown, page: number): Rec => {
  const p = isRecord(payload) ? payload : {};
  const totalPages = num(p.TotalPages);
  return omitEmpty({
    page,
    total_pages: totalPages,
    ...(totalPages !== undefined && page + 1 < totalPages ? { next_page: page + 1 } : {}),
    links: asArray(p.Details)
      .filter(isRecord)
      .map((l) => omitEmpty({ from_url: str(l.Url), anchor_text: str(l.AnchorText) })),
  });
};

export const shapeQuota = (payload: unknown): Rec => {
  const p = isRecord(payload) ? payload : {};
  return omitEmpty({ daily_quota: num(p.DailyQuota), monthly_quota: num(p.MonthlyQuota) });
};

/**
 * GetFetchedUrlDetails returns the fetched page's whole HTML in `Document`. Cut
 * it to a preview by default; the length says how much was left out.
 */
export const shapeFetchedUrl = (payload: unknown, maxDocumentChars: number): Rec => {
  const p = isRecord(payload) ? payload : {};
  const doc = typeof p.Document === "string" ? p.Document : undefined;
  return omitEmpty({
    url: str(p.Url),
    date: str(p.Date),
    status: str(p.Status) ?? num(p.Status),
    headers: str(p.Headers),
    document_length: doc?.length,
    document:
      doc === undefined || maxDocumentChars === 0 ? undefined : doc.slice(0, maxDocumentChars),
    ...(doc !== undefined && doc.length > maxDocumentChars ? { document_truncated: true } : {}),
  });
};

export const shapeFetchedList = (payload: unknown, limit: number): Rec => {
  const rows = asArray(payload)
    .filter(isRecord)
    .map((r) =>
      omitEmpty({ url: str(r.Url), date: str(r.Date), status: str(r.Status) ?? num(r.Status) }),
    );
  const top = rows.slice(0, limit);
  return omitEmpty({
    total: rows.length,
    returned: top.length,
    ...(rows.length > top.length ? { truncated: true } : {}),
    fetched: top,
  });
};

// ---- keyword research -----------------------------------------------------------

export const summarizeKeywordStats = (payload: unknown, window: Partial<DateWindow>): Rec => {
  const rows = asArray(payload)
    .filter(isRecord)
    .map((r) => ({
      day: toDay(r.Date),
      impressions: num(r.Impressions) ?? 0,
      broad: num(r.BroadImpressions) ?? 0,
    }))
    .filter((r): r is { day: string; impressions: number; broad: number } => r.day !== undefined)
    .toSorted((a, b) => (a.day < b.day ? -1 : 1));
  const days = rows.map((r) => r.day);
  const windowed = rows.filter(
    (r) =>
      (window.start === undefined || r.day >= window.start) &&
      (window.end === undefined || r.day <= window.end),
  );
  return omitEmpty({
    granularity: detectGranularity(days),
    data_range: dataRange(days),
    ...(window.start || window.end
      ? {
          window: omitEmpty({ start_date: window.start, end_date: window.end }),
          buckets: bucketsKept(
            windowed.map((r) => r.day),
            detectGranularity(days),
          ),
        }
      : {}),
    totals: {
      impressions: windowed.reduce((s, r) => s + r.impressions, 0),
      broad_impressions: windowed.reduce((s, r) => s + r.broad, 0),
    },
    ...(rows.length === 0
      ? {
          note: "Bing has too little data for this keyword in this market; it returns nothing rather than zeros.",
        }
      : {}),
    series: windowed.map((r) => ({
      date: r.day,
      impressions: r.impressions,
      broad_impressions: r.broad,
    })),
  });
};

export const summarizeRelatedKeywords = (payload: unknown, limit: number): Rec => {
  const rows = asArray(payload)
    .filter(isRecord)
    .map((r) => ({
      query: str(r.Query) ?? "",
      impressions: num(r.Impressions) ?? 0,
      broad_impressions: num(r.BroadImpressions) ?? 0,
    }))
    .filter((r) => r.query !== "")
    .toSorted((a, b) => b.impressions - a.impressions || b.broad_impressions - a.broad_impressions);
  const top = rows.slice(0, limit);
  return omitEmpty({
    total: rows.length,
    returned: top.length,
    ...(rows.length > top.length
      ? { truncated: true, note: `Showing the top ${top.length} of ${rows.length} by impressions.` }
      : {}),
    keywords: top,
  });
};

// ---- the escape hatch's size cap -------------------------------------------------

/**
 * Keep an unshaped response under `maxChars` of JSON. An array is cut to the
 * longest prefix that fits, so what is returned is still valid, whole items;
 * anything else is cut as text. Either way the response says what was cut.
 */
export const capResponse = (value: unknown, maxChars: number): Rec => {
  const size = JSON.stringify(value ?? null).length;
  if (size <= maxChars) return { response: value ?? null };
  if (Array.isArray(value)) {
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (JSON.stringify(value.slice(0, mid)).length <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    return {
      truncated: true,
      items_total: value.length,
      items_returned: lo,
      note: `Response cut to ${lo} of ${value.length} items to stay under max_chars=${maxChars}. Raise max_chars, or use a dedicated tool that filters server-side.`,
      response: value.slice(0, lo),
    };
  }
  return {
    truncated: true,
    total_chars: size,
    note: `Response cut to ${maxChars} of ${size} characters of JSON. Raise max_chars for more.`,
    response_text: JSON.stringify(value).slice(0, maxChars),
  };
};
