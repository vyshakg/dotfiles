#!/usr/bin/env node
/**
 * md-log — mirror a Claude Code session to a markdown file for comfortable
 * reading (e.g. rendered in Obsidian). Claude Code counterpart of
 * ~/.pi/agent/extensions/md-log.ts.
 *
 * Captures only reading-relevant content:
 *   - user prompts
 *   - assistant text
 *   - AskUserQuestion Q&A blocks
 * Everything else (tool calls, thinking, ...) is omitted.
 *
 * Commands (typed in the prompt, intercepted by the UserPromptSubmit hook —
 * no model turn is spent on them):
 *   /md-log <filepath>  — Link an existing markdown file and backfill the session.
 *   /md-unlog           — Stop logging.
 *
 * Hook wiring lives in home/.claude/settings.json. Per-session link state is
 * kept in ~/.claude/md-log/<session_id>.json. Append-only.
 *
 * Live flow: user prompt comes from UserPromptSubmit, assistant text is read
 * from the transcript on PostToolUse/Stop, questions are written on PreToolUse
 * (before the user answers) and answers on PostToolUse.
 *
 * Optional presentation features, all off by default. Enable them in
 * ~/.claude/md-log/config.json, e.g. {"timestamps": true, "dateHeadings": true}:
 *   timestamps     — clock time in every block title ("YOU · 14:32")
 *   dateHeadings   — "## 📅 Mon 12 Oct 2026" heading whenever the day changes
 *   elapsed        — time since the prompt a reply answers ("CLAUDE · 14:32 · +12s")
 *   turnDividers   — horizontal rule before each prompt
 *   sessionHeader  — info callout (cwd, branch, model, session id) when linking
 *   timeFormat     — "24h" (default) or "12h"
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = path.join(os.homedir(), ".claude", "md-log");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const DEFAULT_CONFIG = {
	timestamps: false,
	dateHeadings: false,
	elapsed: false,
	turnDividers: false,
	sessionHeader: false,
	timeFormat: "24h",
};

function loadConfig() {
	try {
		const user = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "config.json"), "utf-8"));
		return user && typeof user === "object" && !Array.isArray(user) ? { ...DEFAULT_CONFIG, ...user } : DEFAULT_CONFIG;
	} catch {
		return DEFAULT_CONFIG;
	}
}

const config = loadConfig();

// --- State (guarded by a mkdir lock: parallel tool calls fire hooks concurrently) ---

const statePath = (sid) => path.join(STATE_DIR, `${sid}.json`);

function readState(sid) {
	try {
		return JSON.parse(fs.readFileSync(statePath(sid), "utf-8"));
	} catch {
		return null;
	}
}

function writeState(sid, state) {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	if (state) fs.writeFileSync(statePath(sid), JSON.stringify(state));
	else fs.rmSync(statePath(sid), { force: true });
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(sid, fn) {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	const lock = `${statePath(sid)}.lock`;
	for (let i = 0; ; i++) {
		try {
			fs.mkdirSync(lock);
			break;
		} catch {
			if (i >= 100) fs.rmSync(lock, { recursive: true, force: true }); // stale after ~5s
			else sleep(50);
		}
	}
	try {
		return fn();
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

function appendToFile(file, ...blocks) {
	const text = blocks.filter(Boolean).join("\n\n");
	if (!text) return;
	try {
		const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
		const prefix = current.trim().length > 0 ? "\n\n" : "";
		fs.writeFileSync(file, `${current}${prefix}${text}\n`, "utf-8");
	} catch {
		// File may have been deleted externally; ignore.
	}
}

// --- Formatting ---

const pad = (n) => String(n).padStart(2, "0");

function toDate(ts) {
	const d = new Date(ts ?? Date.now());
	return Number.isNaN(d.getTime()) ? new Date() : d;
}

function clock(d) {
	if (config.timeFormat === "12h") return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const dayHeading = (d) =>
	`## 📅 ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}`;

function duration(ms) {
	const s = Math.round(ms / 1000);
	if (s < 1) return "";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${pad(s % 60)}s` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/**
 * Blocks stay structured until write time so presentation options (timestamps,
 * headings, dividers) can be applied uniformly in emit(). Give either `lines`
 * (quoted inside the callout) or `text` (rendered below the callout title).
 * `since` is the start of the turn a reply belongs to, for the elapsed option.
 */
function block(kind, type, title, { ts, lines, text, since }) {
	return { kind, type, title, ts: toDate(ts), lines, text, since };
}

function renderBlock(b) {
	const meta = [];
	if (config.timestamps) meta.push(clock(b.ts));
	if (config.elapsed && b.since) {
		const elapsed = duration(b.ts - toDate(b.since));
		if (elapsed) meta.push(`+${elapsed}`);
	}
	const head = `> [!${b.type}] ${b.title}${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
	if (b.text !== undefined) return `${head}\n\n${b.text}`;
	return [head, ...b.lines.map((line) => (line.length === 0 ? ">" : `> ${line}`))].join("\n");
}

const hasContent = (file) => {
	try {
		return fs.statSync(file).size > 0;
	} catch {
		return false;
	}
};

/** Render blocks (plus date headings / dividers), append them, and persist state. */
function emit(sid, state, ...blocks) {
	const out = [];
	// A leading "---" in a note would be read as frontmatter, so never start a file with one.
	const fileHadContent = hasContent(state.file);
	for (const b of blocks.filter(Boolean)) {
		const day = dayKey(b.ts);
		if (config.dateHeadings && day !== state.lastDay) {
			out.push(dayHeading(b.ts));
			state.lastDay = day;
		} else if (config.turnDividers && b.kind === "user" && (fileHadContent || out.length > 0)) {
			out.push("---");
		}
		out.push(renderBlock(b));
	}
	appendToFile(state.file, ...out);
	writeState(sid, state);
}

const callout = (kind, type, title, lines, ts) => block(kind, type, title, { ts, lines });
const userBlock = (text, ts) => block("user", "quote", "YOU", { ts, text });
const assistantBlock = (text, ts, since) => block("assistant", "abstract", "CLAUDE", { ts, text, since });

function sessionHeader(input, info) {
	const lines = [`📁 ${input.cwd ?? process.cwd()}`];
	if (info.branch) lines.push(`🌿 ${info.branch}`);
	if (info.model) lines.push(`🤖 ${info.model}`);
	lines.push(`🆔 ${input.session_id}`);
	return callout("header", "info", "Claude Code session", lines, info.startedAt);
}

function questionBlocks(questions, ts) {
	return (questions ?? []).map((q) => {
		const body = String(q.question ?? "").split("\n");
		const options = q.options ?? [];
		if (options.length > 0) {
			body.push("");
			options.forEach((o, i) => {
				body.push(`${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
			});
		}
		if (q.multiSelect) body.push("", "(multiple selections allowed)");
		return callout("question", "question", q.header ? `Question — ${q.header}` : "Question", body, ts);
	});
}

function answerBlock(questions, result, ts) {
	const answers = result?.answers;
	if (!answers || typeof answers !== "object") {
		return callout("answer", "warning", "Question — cancelled", ["(user skipped)"], ts);
	}
	const body = [];
	const list = questions?.length ? questions : Object.keys(answers).map((question) => ({ question }));
	for (const q of list) {
		const answer = answers[q.question];
		if (answer === undefined) continue;
		const labels = new Set((q.options ?? []).map((o) => o.label));
		const parts = String(answer).split(", ");
		// Free-text "Other" answers aren't among the option labels.
		const text = parts.every((p) => labels.has(p)) ? String(answer) : `Other: ${answer}`;
		if (list.length > 1) body.push(`${q.header ?? q.question}: ${text}`);
		else body.push(text);
		const note = result?.annotations?.[q.question]?.notes;
		if (note) body.push(`Note: ${note}`);
	}
	if (body.length === 0) body.push("(no answer)");
	return callout("answer", "example", "Answer", body, ts);
}

// --- Transcript parsing ---

function readTranscript(file) {
	let raw = "";
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return { entries: [], lines: 0 };
	}
	const lines = raw.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const entries = [];
	for (const line of lines) {
		try {
			entries.push(JSON.parse(line));
		} catch {
			entries.push(null);
		}
	}
	return { entries, lines: entries.length };
}

function findTranscript(sid) {
	try {
		for (const dir of fs.readdirSync(PROJECTS_DIR)) {
			const candidate = path.join(PROJECTS_DIR, dir, `${sid}.jsonl`);
			if (fs.existsSync(candidate)) return candidate;
		}
	} catch {
		// no projects dir
	}
	return null;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
}

// Slash commands are stored as <command-name>/x</command-name><command-args>..</command-args>;
// system reminders and local-command output are injected noise.
function cleanUserText(text) {
	const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
	if (cmd) {
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
		return `${cmd[1].trim()}${args ? ` ${args}` : ""}`;
	}
	return text
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, "")
		.trim();
}

const isMdLogCommand = (text) => /^\/md-(un)?log(\s|$)/.test(text);

function assistantText(entry) {
	if (entry.type !== "assistant" || entry.isSidechain || entry.message?.model === "<synthetic>") return "";
	return textOf(entry.message?.content).trim();
}

/** Live mode: assistant text only (prompts and questions arrive via their own hooks). */
function syncAssistant(sid, state, seen) {
	const { entries, lines } = readTranscript(state.transcript);
	const blocks = [];
	for (const entry of entries.slice(state.cursor)) {
		const text = entry && assistantText(entry);
		if (!text) continue;
		if (text === seen?.text) seen.found = true;
		// Already written straight from the Stop hook (transcript lagged behind it).
		if (text === state.written) state.written = undefined;
		else {
			blocks.push(assistantBlock(text, entry.timestamp, state.turnStart));
			state.lastSynced = text;
		}
	}
	state.cursor = lines;
	emit(sid, state, ...blocks);
}

/**
 * Hooks fire before Claude Code has flushed the transcript, so the final reply
 * is often missing at Stop. Wait briefly for it; if it still isn't there, take
 * it from the hook input and remember it so the later transcript read skips it.
 */
function syncAtStop(sid, state, lastMessage) {
	const last = String(lastMessage ?? "").trim();
	const flushed = () =>
		!last || readTranscript(state.transcript).entries.slice(state.cursor).some((e) => e && assistantText(e) === last);
	for (let i = 0; i < 20 && !flushed(); i++) sleep(100);
	const seen = { text: last, found: false };
	syncAssistant(sid, state, seen);
	// lastSynced: an earlier hook this turn already read the reply from the transcript.
	if (last && !seen.found && last !== state.lastSynced) {
		state.written = last;
		emit(sid, state, assistantBlock(last, undefined, state.turnStart));
	}
}

/** Link time: render the whole transcript so far, in order. */
function backfill(transcript) {
	const { entries, lines } = readTranscript(transcript);
	const questionsById = new Map();
	const blocks = [];
	const info = {};
	let turnStart;
	for (const entry of entries) {
		if (!entry || entry.isSidechain) continue;
		const content = entry.message?.content;
		info.startedAt ??= entry.timestamp;
		info.branch = entry.gitBranch || info.branch;

		if (entry.type === "user" && !entry.isMeta) {
			const toolResult = Array.isArray(content) && content.find((c) => c?.type === "tool_result");
			if (toolResult) {
				const questions = questionsById.get(toolResult.tool_use_id);
				if (questions) blocks.push(answerBlock(questions, entry.toolUseResult, entry.timestamp));
				continue;
			}
			const text = cleanUserText(textOf(content).trim());
			if (text && !isMdLogCommand(text)) {
				turnStart = entry.timestamp;
				blocks.push(userBlock(text, entry.timestamp));
			}
		} else if (entry.type === "assistant") {
			if (entry.message?.model && entry.message.model !== "<synthetic>") info.model = entry.message.model;
			// Text precedes its tool_use in the same turn, so emit it first.
			const text = assistantText(entry);
			if (text) blocks.push(assistantBlock(text, entry.timestamp, turnStart));
			for (const c of Array.isArray(content) ? content : []) {
				if (c?.type === "tool_use" && c.name === "AskUserQuestion") {
					questionsById.set(c.id, c.input?.questions ?? []);
					blocks.push(...questionBlocks(c.input?.questions, entry.timestamp));
				}
			}
		}
	}
	return { blocks, lines, info, turnStart };
}

// --- Commands ---

const expand = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

function handleLink(input, arg) {
	if (!arg) return "Usage: /md-log <filepath>";
	const resolved = path.resolve(input.cwd ?? process.cwd(), expand(arg));
	// /md-log links into an existing note, it never creates one — avoids
	// scattering files (and directories) around the vault from a typo'd path.
	if (!fs.existsSync(resolved)) return `File does not exist: ${resolved}`;
	if (!fs.statSync(resolved).isFile()) return `Not a file: ${resolved}`;

	return withLock(input.session_id, () => {
		if (readState(input.session_id)?.file === resolved) return `Already linked: ${resolved}`;
		const transcript = input.transcript_path ?? findTranscript(input.session_id);
		const { blocks, lines, info, turnStart } = transcript ? backfill(transcript) : { blocks: [], lines: 0, info: {} };
		const header = config.sessionHeader ? [sessionHeader(input, info)] : [];
		emit(input.session_id, { file: resolved, transcript, cursor: lines, turnStart }, ...header, ...blocks);
		return `Linked: ${resolved} (${blocks.length} blocks backfilled)`;
	});
}

function handleUnlog(input) {
	return withLock(input.session_id, () => {
		const state = readState(input.session_id);
		if (!state) return "No file linked";
		writeState(input.session_id, null);
		return `Unlinked: ${path.basename(state.file)}`;
	});
}

// --- Hook entry ---

function main() {
	const input = JSON.parse(fs.readFileSync(0, "utf-8"));
	const sid = input.session_id;
	if (!sid) return;

	if (input.hook_event_name === "UserPromptSubmit") {
		const prompt = String(input.prompt ?? "").trim();
		const cmd = /^\/md-(un)?log(?:\s+([\s\S]*))?$/.exec(prompt);
		if (cmd) {
			const reason = cmd[1] ? handleUnlog(input) : handleLink(input, (cmd[2] ?? "").trim());
			process.stdout.write(JSON.stringify({ decision: "block", reason: `🗒 ${reason}` }));
			return;
		}
		withLock(sid, () => {
			const state = readState(sid);
			if (!state) return;
			state.turnStart = new Date().toISOString();
			state.lastSynced = undefined;
			emit(sid, state, userBlock(prompt));
		});
		return;
	}

	withLock(sid, () => {
		const state = readState(sid);
		if (!state) return;
		state.transcript = input.transcript_path ?? state.transcript;

		const isAsk = input.tool_name === "AskUserQuestion";
		if (input.hook_event_name === "PreToolUse" && isAsk) {
			// Flush preceding prose first so the question lands after it.
			syncAssistant(sid, state);
			emit(sid, state, ...questionBlocks(input.tool_input?.questions));
		} else if (input.hook_event_name === "PostToolUse" && isAsk) {
			syncAssistant(sid, state);
			emit(sid, state, answerBlock(input.tool_input?.questions, input.tool_response));
		} else if (input.hook_event_name === "Stop") {
			syncAtStop(sid, state, input.last_assistant_message);
		} else {
			syncAssistant(sid, state);
		}
	});
}

try {
	main();
} catch {
	// Never break the session over logging.
}
