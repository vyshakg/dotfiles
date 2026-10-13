/**
 * md-log — mirror the session to a markdown file for comfortable reading.
 *
 * Designed for long teaching/learning sessions where the terminal is hard on
 * the eyes and markdown/math/code don't render. The linked .md file is meant
 * to be viewed rendered (e.g. in Obsidian), so assistant text with $...$ math,
 * code blocks, and markdown all render natively — no rendering work here.
 *
 * Captures only reading-relevant content:
 *   - user prompts
 *   - assistant text (lesson prose)
 *   - quiz / ask_user_question Q&A blocks
 * Other tools (bash, read, write, edit, ...) are omitted.
 *
 * Quiz/ask questions are written BEFORE the user answers (on tool_call), so the
 * reader sees the question appear live; the answer + feedback are appended on
 * tool_result. The question block NEVER contains the correct answer or
 * explanation (the user reads this file live).
 *
 * Commands:
 *   /md-log <filepath>  — Link a markdown file and backfill the session.
 *   /md-unlog           — Stop logging.
 *
 * Append-only. No send-back-to-agent functionality (that lived in the old
 * .md-link extension this was modeled on).
 *
 * Optional presentation features, all off by default. Enable them in
 * ~/.pi/agent/md-log.json (re-read on every write), e.g.
 * {"timestamps": true, "dateHeadings": true}:
 *   timestamps     — clock time in every block title ("YOU · 14:32")
 *   dateHeadings   — "## 📅 Mon 12 Oct 2026" heading whenever the day changes
 *   elapsed        — time since the prompt a reply answers ("PI · 14:32 · +12s")
 *   turnDividers   — horizontal rule before each prompt
 *   sessionHeader  — info callout (cwd, model, session id) when linking
 *   timeFormat     — "24h" (default) or "12h"
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "md-log.json");

interface Config {
	timestamps: boolean;
	dateHeadings: boolean;
	elapsed: boolean;
	turnDividers: boolean;
	sessionHeader: boolean;
	timeFormat: "24h" | "12h";
}

const DEFAULT_CONFIG: Config = {
	timestamps: false,
	dateHeadings: false,
	elapsed: false,
	turnDividers: false,
	sessionHeader: false,
	timeFormat: "24h",
};

function loadConfig(): Config {
	try {
		const user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
		return user && typeof user === "object" && !Array.isArray(user) ? { ...DEFAULT_CONFIG, ...user } : DEFAULT_CONFIG;
	} catch {
		return DEFAULT_CONFIG;
	}
}

type TimeLike = Date | string | number | undefined;

/**
 * Blocks stay structured until write time so presentation options (timestamps,
 * headings, dividers) can be applied uniformly. Give either `lines` (quoted
 * inside the callout) or `text` (rendered below the callout title). `since` is
 * the start of the turn a reply belongs to, for the elapsed option.
 */
interface Block {
	kind: "user" | "assistant" | "question" | "answer" | "header";
	type: string;
	title: string;
	ts: Date;
	lines?: string[];
	text?: string;
	since?: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");

function toDate(ts: TimeLike): Date {
	const d = new Date(ts ?? Date.now());
	return Number.isNaN(d.getTime()) ? new Date() : d;
}

function clock(d: Date, cfg: Config): string {
	if (cfg.timeFormat === "12h") return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const dayHeading = (d: Date) =>
	`## 📅 ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}`;

function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 1) return "";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${pad(s % 60)}s` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

function renderBlock(b: Block, cfg: Config): string {
	const meta: string[] = [];
	if (cfg.timestamps) meta.push(clock(b.ts, cfg));
	if (cfg.elapsed && b.since) {
		const elapsed = duration(b.ts.getTime() - b.since.getTime());
		if (elapsed) meta.push(`+${elapsed}`);
	}
	const head = `> [!${b.type}] ${b.title}${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
	if (b.text !== undefined) return `${head}\n\n${b.text}`;
	return [head, ...(b.lines ?? []).map((line) => (line.length === 0 ? ">" : `> ${line}`))].join("\n");
}

/**
 * Render blocks plus date headings / dividers. `lastDay` is the day of the
 * previous block; returns the new one. A leading "---" in a note would be read
 * as frontmatter, so no divider is emitted unless something precedes it.
 */
function renderBlocks(blocks: Block[], cfg: Config, lastDay: string | undefined, fileHadContent: boolean) {
	const out: string[] = [];
	for (const b of blocks) {
		const day = dayKey(b.ts);
		if (cfg.dateHeadings && day !== lastDay) {
			out.push(dayHeading(b.ts));
			lastDay = day;
		} else if (cfg.turnDividers && b.kind === "user" && (fileHadContent || out.length > 0)) {
			out.push("---");
		}
		out.push(renderBlock(b, cfg));
	}
	return { out, lastDay };
}

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;
	let lastDay: string | undefined; // day of the last block written (for dateHeadings)
	let turnStart: Date | undefined; // when the prompt being answered was submitted (for elapsed)

	// --- State restoration on session restart ---

	pi.on("session_start", async (_event, ctx) => {
		let lastLinkData: { file: string | null } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "md-log") {
				lastLinkData = entry.data as { file: string | null } | undefined;
			}
		}
		lastDay = undefined;
		turnStart = undefined;
		if (lastLinkData?.file) {
			logFile = lastLinkData.file;
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"md-log",
				theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(logFile)),
			);
		}
	});

	// --- Serialization: events can fire close together; keep appends ordered ---

	let writeLock: Promise<void> = Promise.resolve();
	function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const prev = writeLock;
		let release: () => void;
		writeLock = new Promise<void>((r) => {
			release = r;
		});
		return prev.then(fn).finally(() => release!());
	}

	function appendToFile(text: string): void {
		if (!logFile) return;
		try {
			let current = "";
			if (fs.existsSync(logFile)) {
				current = fs.readFileSync(logFile, "utf-8");
			}
			const prefix = current.trim().length > 0 ? "\n\n" : "";
			fs.writeFileSync(logFile, current + prefix + text + "\n", "utf-8");
		} catch {
			// File may have been deleted externally; ignore.
		}
	}

	function appendBlocks(...blocks: Block[]): void {
		if (!logFile || blocks.length === 0) return;
		let fileHadContent = false;
		try {
			fileHadContent = fs.statSync(logFile).size > 0;
		} catch {
			// missing file: appendToFile will recreate it
		}
		const rendered = renderBlocks(blocks, loadConfig(), lastDay, fileHadContent);
		lastDay = rendered.lastDay;
		appendToFile(rendered.out.join("\n\n"));
	}

	// --- Formatting ---

	function callout(kind: Block["kind"], type: string, title: string, bodyLines: string[], ts?: TimeLike): Block {
		return { kind, type, title, ts: toDate(ts), lines: bodyLines };
	}

	function userBlock(text: string, ts?: TimeLike): Block {
		return { kind: "user", type: "quote", title: "YOU", ts: toDate(ts), text };
	}

	function sessionHeader(ctx: any, info: { startedAt?: TimeLike; model?: string }): Block {
		const lines = [`📁 ${ctx.cwd ?? process.cwd()}`];
		if (info.model) lines.push(`🤖 ${info.model}`);
		const sid = ctx.sessionManager?.getSessionId?.();
		if (sid) lines.push(`🆔 ${sid}`);
		return callout("header", "info", "Pi session", lines, info.startedAt);
	}

	// Skill declarations (`<skill name="..." ...> ...whole SKILL.md... </skill>`)
	// are system-injected context, not user prose. Replace each with a compact
	// callout noting the skill was loaded, so the log keeps the signal without
	// the noise. Runs on already-trimmed text.
	function stripSkillBlocks(text: string): string {
		return text.replace(
			/<skill\b([^>]*)>[\s\S]*?<\/skill>/g,
			(_match, attrs: string) => {
				const name = /name="([^"]+)"/.exec(attrs)?.[1];
				return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`;
			},
		);
	}

	function assistantBlock(text: string, ts?: TimeLike, since?: Date): Block {
		return { kind: "assistant", type: "abstract", title: "PI", ts: toDate(ts), text, since };
	}

	function optionsList(options: Array<{ label: string }>): string[] {
		return options.map((o, i) => `${i + 1}. ${o.label}`);
	}

	function questionCallout(label: string, question: string, context: string | undefined, options: Array<{ label: string }>, ts?: TimeLike): Block {
		const body: string[] = [];
		for (const line of question.split("\n")) body.push(line);
		if (context) {
			body.push("");
			for (const line of context.split("\n")) body.push(line);
		}
		if (options.length > 0) {
			body.push("");
			body.push(...optionsList(options));
		}
		return callout("question", "question", label, body, ts);
	}

	function answerCalloutQuiz(details: any, ts?: TimeLike): Block {
		const status = details?.status;
		if (status === "cancelled") {
			return callout("answer", "warning", "Quiz — cancelled", ["(user skipped)"], ts);
		}
		if (status === "unavailable") {
			return callout("answer", "warning", "Quiz — unavailable", [details?.message || ""], ts);
		}
		// "I don't know" is neither correct nor incorrect — it's a distinct signal,
		// so it never renders as a red ✗.
		const dontKnow = details?.dontKnow === true;
		const correct = details?.correct === true;
		const type = dontKnow ? "question" : correct ? "success" : "failure";
		const title = dontKnow
			? "Quiz — I don't know"
			: correct
				? "Quiz — correct ✓"
				: "Quiz — incorrect ✗";
		const body: string[] = [];

		if (dontKnow) {
			body.push("Your answer: I don't know");
		} else {
			const answers: any[] = details?.answers || [];
			const sel = answers.map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
			body.push(`Your answer: ${sel}`);
		}

		const correctIndices: number[] = details?.correctIndices || [];
		const correctStr = correctIndices.map((i) => `${i}`).join(", ");
		body.push(`Correct answer: ${correctStr}`);

		// Optional free-text note the user typed in the always-present note field.
		// Only present (in details) when non-empty, so no guard for empty strings.
		if (details?.note) {
			body.push("");
			const noteLines = String(details.note).split("\n");
			body.push(`Note: ${noteLines[0]}`);
			for (let i = 1; i < noteLines.length; i++) body.push(noteLines[i]);
		}

		if (details?.explanation) {
			body.push("");
			for (const line of String(details.explanation).split("\n")) body.push(line);
		}
		return callout("answer", type, title, body, ts);
	}

	function answerCalloutAsk(details: any, ts?: TimeLike): Block {
		const status = details?.status;
		if (status === "cancelled") {
			return callout("answer", "warning", "Question — cancelled", ["(user skipped)"], ts);
		}
		if (status === "unavailable") {
			return callout("answer", "warning", "Question — unavailable", [details?.message || ""], ts);
		}
		const answers: any[] = details?.answers || [];
		const body: string[] = answers.map((a) => {
			if (a.type === "other") return `Other: ${a.label}`;
			if (a.type === "text") return a.label;
			return `${a.index}. ${a.label}`;
		});
		if (body.length === 0) body.push("(no answer)");
		return callout("answer", "example", "Answer", body, ts);
	}

	// --- Event handlers ---

	pi.on("message_end", async (event, _ctx) => {
		if (!logFile) return;
		const msg = event.message;
		if (!msg || !("role" in msg)) return;

		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
					: "";
			const trimmed = stripSkillBlocks(text.trim());
			if (!trimmed) return;
			const ts = toDate((msg as any).timestamp);
			turnStart = ts;
			await withLock(() => appendBlocks(userBlock(trimmed, ts)));
			return;
		}

		if (msg.role === "assistant") {
			const textParts = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => (c.text as string).trim())
				.filter((t: string) => t.length > 0);
			if (textParts.length === 0) return;
			const block = assistantBlock(textParts.join("\n\n"), (msg as any).timestamp, turnStart);
			await withLock(() => appendBlocks(block));
			return;
		}
		// toolResult messages are handled by the tool_result event (for QA tools).
	});

	// ask_user_question never shuffles its options, so the tool_call args are
	// already the true display order — safe to write the question live, before
	// the user answers.
	pi.on("tool_call", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (toolName !== "ask_user_question") return;
		const input = (event as any).input || {};
		const question: string = input.question || "";
		const context: string | undefined = input.details?.trim() || undefined;
		const options: Array<{ label: string }> = Array.isArray(input.options) ? input.options : [];
		const block = questionCallout("Question", question, context, options);
		await withLock(() => appendBlocks(block));
	});

	// quiz DOES shuffle its options inside execute(), so the tool_call args are
	// the pre-shuffle author order — NOT what the user is shown. quiz emits an
	// onUpdate() with the true (post-shuffle) order before it blocks on the
	// user's answer; wait for that instead so the logged order always matches
	// what's on screen. Guard against duplicate writes if multiple updates fire
	// for the same call.
	const loggedQuizQuestion = new Set<string>();
	pi.on("tool_execution_update", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (toolName !== "quiz") return;
		const toolCallId = (event as any).toolCallId;
		if (loggedQuizQuestion.has(toolCallId)) return;
		const shuffled = (event as any).partialResult?.details?.options as Array<{ index: number; label: string }> | undefined;
		if (!shuffled || shuffled.length === 0) return;
		loggedQuizQuestion.add(toolCallId);
		const input = (event as any).args || {};
		const question: string = input.question || "";
		const context: string | undefined = input.details?.trim() || undefined;
		const options = shuffled.map((o) => ({ label: o.label }));
		const block = questionCallout("Quiz", question, context, options);
		await withLock(() => appendBlocks(block));
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (!QA_TOOLS.has(toolName)) return;
		const details = (event as any).details;
		const block = toolName === "quiz"
			? answerCalloutQuiz(details)
			: answerCalloutAsk(details);
		await withLock(() => appendBlocks(block));
	});

	// --- Commands ---

	pi.registerCommand("md-log", {
		description: "Mirror the session to a markdown file (backfills history)",
		handler: async (args, ctx: any) => {
			const filepath = args.trim();
			if (!filepath) {
				ctx.ui.notify("Usage: /md-log <filepath>", "warning");
				return;
			}
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before linking.", "warning");
				return;
			}

			const resolved = path.isAbsolute(filepath) ? filepath : path.resolve(ctx.cwd, filepath);

			// The file must already exist — /md-log links into an existing note,
			// it never creates one. This avoids silently scattering new files
			// (and parent directories) around the vault from a typo'd path.
			if (!fs.existsSync(resolved)) {
				ctx.ui.notify(`File does not exist: ${resolved}`, "error");
				return;
			}
			if (!fs.statSync(resolved).isFile()) {
				ctx.ui.notify(`Not a file: ${resolved}`, "error");
				return;
			}

			logFile = resolved;
			lastDay = undefined;
			pi.appendEntry("md-log", { file: resolved });

			// Backfill the active branch.
			const written = backfill(ctx);

			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"md-log",
				theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(resolved)),
			);
			ctx.ui.notify(`Linked: ${resolved} (${written} entries backfilled)`, "success");
		},
	});

	pi.registerCommand("md-unlog", {
		description: "Stop mirroring the session to a markdown file",
		handler: async (_args, ctx) => {
			if (!logFile) {
				ctx.ui.notify("No file linked", "warning");
				return;
			}
			const name = path.basename(logFile);
			logFile = null;
			lastDay = undefined;
			turnStart = undefined;
			pi.appendEntry("md-log", { file: null });
			ctx.ui.setStatus("md-log", undefined);
			ctx.ui.notify(`Unlinked: ${name}`, "info");
		},
	});

	// --- Backfill ---

	function backfill(ctx: any): number {
		if (!logFile) return 0;
		const entries: any[] = ctx.sessionManager.getEntries();
		if (entries.length === 0) return 0;

		const byId = new Map<string, any>();
		for (const e of entries) if (e.id) byId.set(e.id, e);

		// Active leaf = last entry that has an id (skip the session header).
		let leaf: any = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].id) {
				leaf = entries[i];
				break;
			}
		}
		if (!leaf) return 0;

		// Walk parent chain to root.
		const chain: any[] = [];
		let cur: any = leaf;
		const seen = new Set<string>();
		while (cur && cur.id && !seen.has(cur.id)) {
			seen.add(cur.id);
			chain.push(cur);
			cur = cur.parentId ? byId.get(cur.parentId) : null;
		}
		chain.reverse();

		// Track tool-call args from assistant messages so we can pair with results.
		const toolCallArgs = new Map<string, { name: string; args: any }>();

		const blocks: Block[] = [];
		const info: { startedAt?: TimeLike; model?: string } = {};
		let backfillTurnStart: Date | undefined;
		let count = 0;
		for (const entry of chain) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg || !("role" in msg)) continue;
			count++;
			const ts: TimeLike = entry.timestamp ?? msg.timestamp;
			info.startedAt ??= ts;

			if (msg.role === "user") {
				const text = typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
						: "";
				const trimmed = stripSkillBlocks(text.trim());
				if (trimmed) {
					backfillTurnStart = toDate(ts);
					blocks.push(userBlock(trimmed, ts));
				}
				continue;
			}

			if (msg.role === "assistant") {
				if (msg.model) info.model = msg.model;
				// Index tool calls for later pairing.
				for (const c of msg.content || []) {
					if (c.type === "toolCall" && QA_TOOLS.has(c.name)) {
						toolCallArgs.set(c.id, { name: c.name, args: c.arguments });
					}
				}
				const textParts = (msg.content || [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => (c.text as string).trim())
					.filter((t: string) => t.length > 0);
				if (textParts.length > 0) blocks.push(assistantBlock(textParts.join("\n\n"), ts, backfillTurnStart));
				continue;
			}

			if (msg.role === "toolResult") {
				if (!QA_TOOLS.has(msg.toolName)) continue;
				const tc = toolCallArgs.get(msg.toolCallId);
				// Question block. For quiz, use the persisted result's `details.options`
				// — the TRUE post-shuffle display order the user actually saw — rather
				// than the original tool-call args, which are the pre-shuffle author
				// order and can mismatch what's on screen. ask_user_question never
				// shuffles, so its tool-call args are already the true order.
				if (tc) {
					const a = tc.args || {};
					const label = tc.name === "quiz" ? "Quiz" : "Question";
					const shuffled = msg.toolName === "quiz"
						? (msg.details?.options as Array<{ index: number; label: string }> | undefined)
						: undefined;
					const options = shuffled && shuffled.length > 0
						? shuffled.map((o) => ({ label: o.label }))
						: (Array.isArray(a.options) ? a.options : []);
					blocks.push(questionCallout(label, a.question || "", a.details?.trim() || undefined, options, ts));
				}
				if (msg.toolName === "quiz") {
					blocks.push(answerCalloutQuiz(msg.details, ts));
				} else {
					blocks.push(answerCalloutAsk(msg.details, ts));
				}
				continue;
			}
		}

		turnStart = backfillTurnStart;
		const cfg = loadConfig();
		if (cfg.sessionHeader) blocks.unshift(sessionHeader(ctx, info));
		if (blocks.length > 0) {
			// The file is rewritten from scratch here, so nothing precedes the first block.
			const rendered = renderBlocks(blocks, cfg, undefined, false);
			lastDay = rendered.lastDay;
			try {
				fs.writeFileSync(logFile, rendered.out.join("\n\n") + "\n", "utf-8");
			} catch {
				// ignore
			}
		}
		return count;
	}
}
