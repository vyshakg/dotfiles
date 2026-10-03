/**
 * herdr surface layer - the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the herdr calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by herdr pane ids (e.g. `w1:p3`). Splits always target
 * the parent pi's pane (`$HERDR_PANE_ID`) and never take focus, so they follow
 * the agent rather than the user's focus. The `herdr` CLI inherits
 * `$HERDR_SOCKET_PATH` from the parent pane, so it always talks to the herdr
 * session the parent pi runs in.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/** herdr exports its own binary path into every pane it manages. */
function herdrBin(): string {
  const fromEnv = process.env.HERDR_BIN_PATH;
  return fromEnv && existsSync(fromEnv) ? fromEnv : "herdr";
}

/**
 * True when running inside a herdr pane with the herdr binary available.
 * herdr sets `HERDR_ENV=1` and `HERDR_PANE_ID` in every pane it spawns.
 */
export function isHerdrAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return false;
  const bin = herdrBin();
  return bin !== "herdr" || hasCommand("herdr");
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside a herdr pane (run `herdr`, then `pi`).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${muxSetupHint()}`);
  }
}

function herdr(args: string[]): string {
  return execFileSync(herdrBin(), args, { encoding: "utf8" });
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HerdrLayout {
  focused_pane_id?: string;
  panes: Array<{ pane_id: string; rect: Rect }>;
  splits: Array<{ id: string; direction: string; ratio: number; rect: Rect }>;
}

export interface LayoutResize {
  paneId: string;
  direction: "left" | "right";
  amount: number;
}

/**
 * Panes this process may resize: the parent pi pane plus every subagent pane
 * it created. Kept on globalThis so the set survives /reload re-imports.
 */
const MANAGED_PANES_KEY = Symbol.for("pi-subagents/herdr-managed-panes");
function managedPanes(): Set<string> {
  const g = globalThis as any;
  g[MANAGED_PANES_KEY] ??= new Set<string>();
  return g[MANAGED_PANES_KEY];
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Compute the resizes that make subagent columns evenly sized - the herdr
 * equivalent of tmux's `even-horizontal` layout, but scoped to the parent pi
 * pane and its subagents so the user's own panes are never touched.
 *
 * herdr halves the target pane on every split, so repeated right-splits off
 * the parent leave it at 1/2, 1/4, 1/8... of its width. Every split is a
 * binary node with a ratio; for each right-split whose panes are all managed,
 * full-height columns, the even ratio is `leftColumns / totalColumns`.
 *
 * `herdr pane resize --direction D --amount A` grows the pane toward D by A
 * (in units of the affected split's ratio). Growing the column adjacent to a
 * split's boundary therefore moves exactly that split.
 */
export function planEvenColumns(layout: HerdrLayout, managed: Set<string>): LayoutResize[] {
  const resizes: LayoutResize[] = [];
  for (const split of layout.splits) {
    if (split.direction !== "right") continue;
    const panes = layout.panes.filter((pane) => contains(split.rect, pane.rect));
    if (panes.length < 2) continue;
    if (!panes.every((pane) => managed.has(pane.pane_id))) continue;
    if (!panes.every((pane) => pane.rect.height === split.rect.height)) continue;

    const boundary = split.rect.x + split.rect.width * split.ratio;
    const left = panes.filter((pane) => pane.rect.x + pane.rect.width / 2 < boundary);
    const right = panes.filter((pane) => pane.rect.x + pane.rect.width / 2 >= boundary);
    if (left.length === 0 || right.length === 0) continue;

    const delta = left.length / panes.length - split.ratio;
    if (Math.abs(delta) < 0.01) continue;
    if (delta > 0) {
      const edge = left.reduce((a, b) => (b.rect.x > a.rect.x ? b : a));
      resizes.push({ paneId: edge.pane_id, direction: "right", amount: delta });
    } else {
      const edge = right.reduce((a, b) => (b.rect.x < a.rect.x ? b : a));
      resizes.push({ paneId: edge.pane_id, direction: "left", amount: -delta });
    }
  }
  return resizes;
}

export function readLayout(pane: string): HerdrLayout {
  const out = herdr(["pane", "layout", "--pane", pane]);
  return JSON.parse(out).result.layout as HerdrLayout;
}

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * Debounced so a burst of parallel spawns or staggered exits collapses into a
 * single pass, and non-fatal: a cosmetic resize must never break spawning or
 * watching.
 */
function rebalanceSurfaces(): void {
  const parent = process.env.HERDR_PANE_ID;
  if (!parent) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      const managed = new Set([parent, ...managedPanes()]);
      for (const resize of planEvenColumns(readLayout(parent), managed)) {
        herdr([
          "pane",
          "resize",
          "--pane",
          resize.paneId,
          "--direction",
          resize.direction,
          "--amount",
          resize.amount.toFixed(4),
        ]);
      }
    } catch {
      // Pane/tab may be gone; balancing is best-effort.
    }
  }, 120);
  rebalanceTimer.unref?.();
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `w1:p3`).
 */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right", process.env.HERDR_PANE_ID);
}

/**
 * Create a new split in the given direction from an optional source pane
 * (defaults to the calling pane). herdr only splits right or down.
 * Returns the new pane id (e.g. `w1:p3`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "right" | "down",
  fromSurface?: string,
): string {
  requireHerdr();

  const args = ["pane", "split"];
  if (fromSurface) {
    args.push("--pane", fromSurface);
  } else {
    args.push("--current");
  }
  args.push("--direction", direction, "--cwd", process.cwd(), "--no-focus");

  const out = herdr(args);
  let pane: unknown;
  try {
    pane = JSON.parse(out)?.result?.pane?.pane_id;
  } catch {}
  if (typeof pane !== "string" || !pane) {
    throw new Error(`Unexpected herdr pane split output: ${out.trim()}`);
  }

  try {
    herdr(["pane", "rename", pane, name]);
  } catch {
    // Labels are cosmetic.
  }

  managedPanes().add(pane);
  rebalanceSurfaces();
  return pane;
}

/**
 * Send a command string to a pane and execute it. `herdr pane run` writes the
 * text and Enter as one ordered submission.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  herdr(["pane", "run", surface, command]);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This keeps the typed command short and avoids terminal line-wrapping issues
 * with very long invocations.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

function readArgs(surface: string, lines: number): string[] {
  // recent-unwrapped joins soft wraps so long lines (and the exit sentinel)
  // match as written.
  return [
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ];
}

/**
 * Read the last `lines` lines of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return herdr(readArgs(surface, lines));
}

/**
 * Read the last `lines` lines of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(herdrBin(), readArgs(surface, lines), {
    encoding: "utf8",
  });
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  managedPanes().delete(surface);
  try {
    herdr(["pane", "close", surface]);
  } finally {
    rebalanceSurfaces();
  }
}

// ── Exit polling ──

/** Lines read per exit poll; roughly one screen, like tmux's visible-screen capture. */
const EXIT_POLL_LINES = 50;

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar - it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, EXIT_POLL_LINES);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed - check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
