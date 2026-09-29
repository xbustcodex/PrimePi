import { describe, expect, it } from "vitest";
import {
	type CommandResult,
	evaluateLoopCondition,
	isUnlimitedTimeout,
	loopConditionSessionKey,
	verdictMessage,
} from "../src/core/loop-condition.ts";

/**
 * The `/loop` continue-condition.
 *
 * The property the whole design exists for: **a broken condition must not look
 * like finished work.** A typo'd command that reads as "false" halts the loop
 * for a reason the user cannot see, and the work that was done becomes
 * indistinguishable from a job that completed.
 */

/** A runner that returns a fixed result and records what it was asked. */
function runner(result: Partial<CommandResult>) {
	const calls: { command: string; timeoutMs: number; sessionId: string }[] = [];
	return {
		calls,
		run: async (command: string, options: { timeoutMs: number; sessionId: string }) => {
			calls.push({ command, timeoutMs: options.timeoutMs, sessionId: options.sessionId });
			return { exitCode: 0, stdout: "", stderr: "", ...result } as CommandResult;
		},
	};
}

const base = { timeoutMs: 30_000, sessionId: "session-1" };

describe("exit status decides, stdout does not", () => {
	it("continues on exit 0", async () => {
		const verdict = await evaluateLoopCondition("npm test", { ...base, ...runner({ exitCode: 0 }) });
		expect(verdict.kind).toBe("continue");
	});

	it("halts on exit 1, whatever the output says", async () => {
		// `echo false` exits 0, so "boolean-ish output" and the exit code actively
		// disagree. Reading stdout would mean inventing a rule about which wins.
		const verdict = await evaluateLoopCondition(
			"echo false",
			{ ...base, ...runner({ exitCode: 1, stdout: "false" }) },
		);
		expect(verdict.kind).toBe("halt");
	});

	it("continues even when stdout says false and the exit code is 0", async () => {
		const verdict = await evaluateLoopCondition(
			"echo false",
			{ ...base, ...runner({ exitCode: 0, stdout: "false" }) },
		);
		// Every predicate a user already reaches for speaks exit codes: test,
		// grep -q, git diff --quiet. Reading them keeps a condition a condition.
		expect(verdict.kind).toBe("continue");
	});
});

describe("a broken condition is an error, never a halt", () => {
	it("reports command-not-found as an error", async () => {
		const verdict = await evaluateLoopCondition("tset --watch", { ...base, ...runner({ exitCode: 127 }) });
		// This is the failure the whole design exists to prevent: a typo'd condition
		// that reads as "false" looks exactly like finished work.
		expect(verdict.kind).toBe("error");
		expect(verdict.kind === "error" && verdict.message).toContain("command not found");
	});

	it("reports a syntax error as an error", async () => {
		const verdict = await evaluateLoopCondition("if [ -f x ]", { ...base, ...runner({ exitCode: 2 }) });
		expect(verdict.kind).toBe("error");
	});

	it("reports a non-executable command as an error", async () => {
		const verdict = await evaluateLoopCondition("./build.sh", { ...base, ...runner({ exitCode: 126 }) });
		expect(verdict.kind).toBe("error");
	});

	it("treats an unknown non-zero status as an error rather than a halt", async () => {
		const verdict = await evaluateLoopCondition("whatever", { ...base, ...runner({ exitCode: 42 }) });
		expect(verdict.kind).toBe("error");
		expect(verdict.kind === "error" && verdict.message).toContain("42");
	});

	it("treats a missing exit status as an error", async () => {
		// A signal or a spawn failure produces none, and "no answer" is not "false".
		const verdict = await evaluateLoopCondition("whatever", { ...base, ...runner({ exitCode: null }) });
		expect(verdict.kind).toBe("error");
	});

	it("reports an empty condition as an error", async () => {
		// An empty condition is broken, not passing. Reading it as false would halt
		// the loop for a reason the user cannot see.
		const verdict = await evaluateLoopCondition("   ", { ...base, ...runner({ exitCode: 0 }) });
		expect(verdict.kind).toBe("error");
		expect(verdict.kind === "error" && verdict.message).toContain("empty");
	});

	it("includes the command output in an error, bounded", async () => {
		const verdict = await evaluateLoopCondition("tset", {
			...base,
			...runner({ exitCode: 127, stderr: "x".repeat(500) }),
		});
		expect(verdict.kind).toBe("error");
		if (verdict.kind !== "error") return;
		// Bounded, so a large output cannot flood a one-line status.
		expect(verdict.message.length).toBeLessThan(200);
	});
});

describe("timeouts", () => {
	it("reports a timeout as an error, not a halt", async () => {
		// The condition never answered, so "false" would be a guess.
		const verdict = await evaluateLoopCondition("sleep 999", { ...base, ...runner({ timedOut: true }) });
		expect(verdict.kind).toBe("error");
		expect(verdict.kind === "error" && verdict.message).toContain("timed out");
	});

	it("recognises an unlimited timeout", () => {
		// A condition that legitimately takes minutes exists, and a user who wants
		// that should be able to say so.
		expect(isUnlimitedTimeout(0)).toBe(true);
		expect(isUnlimitedTimeout(30_000)).toBe(false);
	});

	it("says so when a timeout happened without a bound", async () => {
		const verdict = await evaluateLoopCondition("sleep 999", {
			...base,
			timeoutMs: 0,
			...runner({ timedOut: true }),
		});
		expect(verdict.kind === "error" && verdict.message).toContain("without a bound");
	});

	it("passes the configured bound through unchanged", async () => {
		const { run, calls } = runner({ exitCode: 0 });
		await evaluateLoopCondition("true", { ...base, timeoutMs: 5_000, run });
		expect(calls[0]!.timeoutMs).toBe(5_000);
	});
});

describe("abort", () => {
	it("reports an abort distinctly, with no message of its own", async () => {
		const verdict = await evaluateLoopCondition("whatever", { ...base, ...runner({ aborted: true }) });
		expect(verdict.kind).toBe("aborted");
		// The caller owns that UX; inventing a message here would print a second,
		// competing explanation for the user's own keypress.
		expect(verdictMessage(verdict)).toBeUndefined();
	});
});

describe("isolation", () => {
	it("runs the condition in its own shell session", async () => {
		const { run, calls } = runner({ exitCode: 0 });
		await evaluateLoopCondition("cd /tmp", { ...base, run });
		// A `cd` inside a condition must not move the agent's working directory.
		expect(calls[0]!.sessionId).not.toBe("session-1");
		expect(calls[0]!.sessionId.startsWith("loop-condition-")).toBe(true);
	});

	it("scopes the session per owner, so two loops cannot share shell state", async () => {
		const a = loopConditionSessionKey("loop-a");
		const b = loopConditionSessionKey("loop-b");
		// Without this, a shared prefix would let one loop observe another's
		// exported variables, and the interference would look like a condition that
		// randomly changes its mind.
		expect(a).not.toBe(b);
		expect(loopConditionSessionKey("loop-a")).toBe(a);
	});

	it("does not put a raw session id into the key", async () => {
		// A session id is user-visible text that may contain characters that are not
		// legal in a session key.
		const key = loopConditionSessionKey("weird id/with:chars");
		expect(key).toMatch(/^loop-condition-[0-9a-f]{12}$/);
	});
});

describe("a runner that throws", () => {
	it("is an error, not a silent pass", async () => {
		const verdict = await evaluateLoopCondition("whatever", {
			...base,
			run: async () => {
				throw new Error("shell unavailable");
			},
		});
		expect(verdict.kind).toBe("error");
		expect(verdict.kind === "error" && verdict.message).toContain("shell unavailable");
	});
});
