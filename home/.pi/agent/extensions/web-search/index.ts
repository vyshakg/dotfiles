import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

type Topic = "general" | "news" | "finance";
type TimeRange = "day" | "week" | "month" | "year";
type Depth = "basic" | "advanced";

interface StructuredSearchArgs {
	query?: string;
	exactPhrases?: string[];
	excludeDomains?: string[];
	site?: string;
	topic?: Topic;
	timeRange?: TimeRange;
	depth?: Depth;
	count?: number;
}

interface BuiltSearchQuery {
	query: string;
	baseQuery?: string;
	exactPhrases: string[];
	includeDomains: string[];
	excludeDomains: string[];
}

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const MAX_RESULTS = 20;
const SNIPPET_LIMIT = 600;
const REQUEST_TIMEOUT_MS = 30_000;

// The key lives in Automic Vault under this name. It is read from the
// environment first (e.g. pi launched via `av inject +TAVILY_SEARCH_API_KEY -- pi`),
// otherwise fetched on demand through `av inject` and kept in memory only.
const VAULT_SECRET = "TAVILY_SEARCH_API_KEY";
// `av inject` may wait on a GUI approval prompt, so allow a human-sized delay.
const VAULT_TIMEOUT_MS = 120_000;

function avBinary(): string {
	if (process.env.AV_BIN) return process.env.AV_BIN;
	return existsSync("/usr/local/bin/av") ? "/usr/local/bin/av" : "av";
}

function fetchKeyFromVault(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			avBinary(),
			["inject", `+${VAULT_SECRET}`, "--", "printenv", VAULT_SECRET],
			{ timeout: VAULT_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout, stderr) => {
				const key = stdout.trim();
				if (error || !key) {
					const detail = (stderr || error?.message || "empty output").trim().split("\n")[0];
					reject(
						new Error(
							`Could not read ${VAULT_SECRET} from Automic Vault (${detail}). ` +
								`Check \`av list\`, approve the access prompt, or set ${VAULT_SECRET} in the environment.`,
						),
					);
					return;
				}
				resolve(key);
			},
		);
	});
}

let cachedKey: Promise<string> | undefined;

function getApiKey(): Promise<string> {
	const fromEnv = process.env[VAULT_SECRET] ?? process.env.TAVILY_API_KEY;
	if (fromEnv) return Promise.resolve(fromEnv);

	// Share one in-flight lookup so parallel searches trigger a single approval
	// prompt, and drop it on failure so the next search can retry.
	cachedKey ??= fetchKeyFromVault().catch((error) => {
		cachedKey = undefined;
		throw error;
	});
	return cachedKey;
}

async function tavilySearch(
	args: BuiltSearchQuery,
	options: { count: number; topic: Topic; timeRange?: TimeRange; depth: Depth },
	apiKey: string,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const body: Record<string, unknown> = {
		query: args.query,
		max_results: Math.min(options.count, MAX_RESULTS),
		search_depth: options.depth,
		topic: options.topic,
	};
	if (options.timeRange) body.time_range = options.timeRange;
	if (args.includeDomains.length > 0) body.include_domains = args.includeDomains;
	if (args.excludeDomains.length > 0) body.exclude_domains = args.excludeDomains;

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const resp = await fetch(TAVILY_SEARCH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Tavily API ${resp.status}: ${text.slice(0, 200)}`);
	}

	const data = (await resp.json()) as {
		results?: Array<{ title?: string; url: string; content?: string }>;
	};

	return (data.results ?? []).map((item) => ({
		title: item.title?.trim() || item.url,
		url: item.url,
		snippet: (item.content ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_LIMIT),
	}));
}

function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
		.join("\n\n");
}

function stripWrappingQuotes(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1).trim()
		: value;
}

function cleanItems(values?: string[]): string[] {
	if (!values) return [];
	return values
		.map((value) => stripWrappingQuotes(value.trim().replace(/\s+/g, " ")))
		.filter(Boolean);
}

function cleanQuery(value?: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.trim().replace(/\s+/g, " ");
	return cleaned || undefined;
}

function normalizeDomain(site?: string): string | undefined {
	if (typeof site !== "string") return undefined;

	let value = site.trim().replace(/^site:/i, "").trim();
	if (!value) return undefined;

	try {
		const candidate = /^[a-z]+:\/\//i.test(value)
			? value
			: `https://${value}`;
		const url = new URL(candidate);
		if (url.hostname) value = url.hostname;
	} catch {}

	return value.replace(/\/+$/, "") || undefined;
}

function quoteForSearch(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(args: StructuredSearchArgs): BuiltSearchQuery {
	const baseQuery = cleanQuery(args.query);
	const exactPhrases = cleanItems(args.exactPhrases);
	const excludeDomains = cleanItems(args.excludeDomains)
		.map(normalizeDomain)
		.filter((domain): domain is string => Boolean(domain));
	const site = normalizeDomain(args.site);

	if (!baseQuery && exactPhrases.length === 0) {
		throw new Error(
			"At least one of 'query' or 'exactPhrases' is required.",
		);
	}

	const parts: string[] = [];
	if (baseQuery) parts.push(baseQuery);
	for (const phrase of exactPhrases) {
		parts.push(quoteForSearch(phrase));
	}

	return {
		query: parts.join(" "),
		baseQuery,
		exactPhrases,
		includeDomains: site ? [site] : [],
		excludeDomains,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via the Tavily Search API. Build one search per call from a base query string, optional exact phrases, an optional site restriction, and optional excluded domains. Returns title, URL, and a content snippet per result.",
		promptSnippet:
			"Search the web via a query string plus optional exactPhrases, site, excludeDomains, topic, and timeRange. Use one tool call per search angle.",
		promptGuidelines: [
			"Keep the query short and focused (under 400 characters); split complex questions into separate web_search calls.",
			"Use one web_search tool call per search angle instead of batching multiple searches into one call.",
			"Use site to restrict results to one domain and excludeDomains to drop noisy domains; use topic 'news' with timeRange for recent events.",
			"Use depth 'advanced' only when precision matters, since it costs more than the default 'basic'.",
		],

		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Base search query as a normal string. Prefer this for the main search wording.",
				}),
			),
			exactPhrases: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Exact phrases to match. Each item is added to the query in quotes (best effort).",
				}),
			),
			site: Type.Optional(
				Type.String({
					description:
						"Optional site/domain restriction, such as example.com or a full URL.",
				}),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String(), {
					description: "Domains to exclude from the results, such as reddit.com.",
				}),
			),
			topic: Type.Optional(
				Type.Union(
					[Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")],
					{ description: "Search category (default: general)." },
				),
			),
			timeRange: Type.Optional(
				Type.Union(
					[
						Type.Literal("day"),
						Type.Literal("week"),
						Type.Literal("month"),
						Type.Literal("year"),
					],
					{ description: "Only return results published within this window." },
				),
			),
			depth: Type.Optional(
				Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
					description:
						"Search depth (default: basic). 'advanced' is more precise but costs more credits.",
				}),
			),
			count: Type.Optional(
				Type.Number({
					description: `Number of results to return (default: 5, max: ${MAX_RESULTS})`,
					minimum: 1,
					maximum: MAX_RESULTS,
				}),
			),
		}),

		async execute(_toolCallId, params: StructuredSearchArgs, signal) {
			const built = buildSearchQuery(params);
			const apiKey = await getApiKey();
			const results = await tavilySearch(
				built,
				{
					count: params.count ?? 5,
					topic: params.topic ?? "general",
					timeRange: params.timeRange,
					depth: params.depth ?? "basic",
				},
				apiKey,
				signal,
			);

			return {
				content: [
					{
						type: "text" as const,
						text: formatResults(results),
					},
				],
				details: {
					composedQuery: built.query,
					query: built.baseQuery,
					exactPhrases: built.exactPhrases,
					includeDomains: built.includeDomains,
					excludeDomains: built.excludeDomains,
					topic: params.topic ?? "general",
					timeRange: params.timeRange,
					depth: params.depth ?? "basic",
					resultCount: results.length,
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { count, ...searchArgs } = args as StructuredSearchArgs;

			try {
				const built = buildSearchQuery(searchArgs);
				const display =
					built.query.length > 70
						? built.query.slice(0, 67) + "..."
						: built.query;
				const lines = [
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("accent", `"${display}"`),
				];
				if (built.includeDomains.length > 0) {
					lines.push(theme.fg("dim", `  site: ${built.includeDomains.join(", ")}`));
				}
				if (count && count !== 5) {
					lines.push(theme.fg("dim", `  count: ${count}`));
				}
				text.setText(lines.join("\n"));
				return text;
			} catch {
				text.setText(
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("error", "(invalid query)"),
				);
				return text;
			}
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Searching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				composedQuery?: string;
				resultCount?: number;
			};
			const status = theme.fg(
				"success",
				`${details?.resultCount ?? 0} results`,
			);
			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500 ? content.slice(0, 500) + "..." : content;
			const queryLine = details?.composedQuery
				? theme.fg("dim", `query: ${details.composedQuery}`)
				: "";
			text.setText(
				[status, queryLine, theme.fg("dim", preview)]
					.filter(Boolean)
					.join("\n"),
			);
			return text;
		},
	});
}
