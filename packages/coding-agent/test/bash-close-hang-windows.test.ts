import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";

function toBashSingleQuotedArg(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

/**
 * Reproduces the inherited-stdio hang from pi#2389 / #5303: a descendant keeps the
 * shell's stdout/stderr pipes open after the direct child exits, so the pipes never
 * reach EOF and waiting on `close` alone hangs.
 *
 * The descendant is a backgrounded shell job rather than a detached `node -e` child.
 * Both hold the pipes open past the direct child's exit, which is the property under
 * test, but the shell form avoids spawning an inline-script node process that
 * antivirus heuristics flag.
 *
 * Two timing invariants keep the test meaningful: the descendant outlives each test's
 * 3000ms guard, so the pipes cannot reach EOF first, and it writes its late marker
 * only after `LATE_MARKER_DELAY_SECONDS`, which is longer than the 100ms idle-grace
 * fallback, so the marker's absence when the call settles proves the grace path is
 * what settled it. The `&&` chain also means a missing `sleep` fails loudly instead
 * of silently reproducing nothing.
 */
const DESCENDANT_HOLD_SECONDS = 30;
const LATE_MARKER_DELAY_SECONDS = 1;

function createInheritedStdioCommand(pidFile: string): string {
	const lateMarker = lateMarkerPathFor(pidFile);
	return (
		`{ sleep ${LATE_MARKER_DELAY_SECONDS} && echo late > ${toBashSingleQuotedArg(lateMarker)}; ` +
		`sleep ${DESCENDANT_HOLD_SECONDS}; } & ` +
		`echo $! > ${toBashSingleQuotedArg(pidFile)} && echo child-exiting`
	);
}

/** Late-marker path paired with a pid file. */
function lateMarkerPathFor(pidFile: string): string {
	return `${pidFile}.late`;
}

/**
 * Fails unless the descendant was still holding the pipes when the call settled.
 * Marker-based rather than `process.kill(pid, 0)`: `$!` is an MSYS PID under Git
 * Bash, which is not the PID space `process.kill`/`taskkill` use on Windows.
 */
function assertDescendantStillHoldingPipes(pidFile: string): void {
	expect(existsSync(lateMarkerPathFor(pidFile))).toBe(false);
}

function cleanupDetachedChild(pidFile: string): void {
	if (!existsSync(pidFile)) {
		return;
	}

	const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
	if (Number.isFinite(pid) && pid > 0) {
		try {
			execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
		} catch {
			// Process may have already exited.
		}
	}
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			onTimeout();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);

		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

describe.skipIf(process.platform !== "win32")("Windows child-process close handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-bash-close-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("executeBash resolves after the shell exits even if inherited stdio handles stay open", async () => {
		const pidFile = join(testDir, "executor-grandchild.pid");
		const command = createInheritedStdioCommand(pidFile);
		const controller = new AbortController();

		try {
			const result = await withTimeout(
				executeBashWithOperations(command, process.cwd(), createLocalBashOperations(), {
					signal: controller.signal,
				}),
				3000,
				() => {
					controller.abort();
				},
			);

			expect(result.output).toContain("child-exiting");
			expect(result.exitCode).toBe(0);
			expect(result.cancelled).toBe(false);
			assertDescendantStillHoldingPipes(pidFile);
		} finally {
			controller.abort();
			cleanupDetachedChild(pidFile);
		}
	});

	it("bash tool resolves after the shell exits even if inherited stdio handles stay open", async () => {
		const pidFile = join(testDir, "tool-grandchild.pid");
		const command = createInheritedStdioCommand(pidFile);
		const controller = new AbortController();
		const bashTool = createBashTool(testDir);

		try {
			const result = await withTimeout(bashTool.execute("test-call", { command }, controller.signal), 3000, () => {
				controller.abort();
			});

			expect(getTextOutput(result)).toContain("child-exiting");
			assertDescendantStillHoldingPipes(pidFile);
		} finally {
			controller.abort();
			cleanupDetachedChild(pidFile);
		}
	});
});
