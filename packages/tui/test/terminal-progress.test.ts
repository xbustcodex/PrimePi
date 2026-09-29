import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	describeProgress,
	PROGRESS_BEGIN,
	PROGRESS_END,
	TerminalProgress,
	terminalSupportsProgress,
} from "../src/terminal/progress.ts";

/**
 * Native terminal progress.
 *
 * The property that makes this safe with more than one session: **progress is
 * only ever cleared by whoever set it.** A session that never turned it on must
 * not clear another session's spinner, or a user watches a taskbar showing
 * nothing while work is genuinely running.
 */

function recorder() {
	const written: string[] = [];
	return { written, write: (sequence: string) => written.push(sequence) };
}

describe("the indicator is owned, not global", () => {
	it("sets when enabled and not already active", () => {
		const sink = recorder();
		const progress = new TerminalProgress({ enabled: true, write: sink.write });
		assert.equal(progress.set(), true);
		assert.deepEqual(sink.written, [PROGRESS_BEGIN]);
	});

	it("does not set twice", () => {
		// Some terminals restart their animation on a repeated begin sequence, which
		// reads as a flicker.
		const sink = recorder();
		const progress = new TerminalProgress({ enabled: true, write: sink.write });
		progress.set();
		assert.equal(progress.set(), false);
		assert.equal(sink.written.length, 1);
	});

	it("clears what it set", () => {
		const sink = recorder();
		const progress = new TerminalProgress({ enabled: true, write: sink.write });
		progress.set();
		assert.equal(progress.clear(), true);
		assert.deepEqual(sink.written, [PROGRESS_BEGIN, PROGRESS_END]);
		assert.equal(progress.active, false);
	});

	it("does not clear progress it never set", () => {
		// The property that makes a second session safe: a clear is an instruction
		// to the terminal, and one session clearing another's spinner leaves a
		// taskbar showing nothing while work is running.
		const sink = recorder();
		const progress = new TerminalProgress({ enabled: true, write: sink.write });
		assert.equal(progress.clear(), false);
		assert.deepEqual(sink.written, []);
	});

	it("does not clear a second time", () => {
		const sink = recorder();
		const progress = new TerminalProgress({ enabled: true, write: sink.write });
		progress.set();
		progress.clear();
		assert.equal(progress.clear(), false);
		assert.equal(sink.written.length, 2);
	});
});

describe("two sessions do not interfere", () => {
	it("one session's clear does not touch another's indicator", () => {
		const sink = recorder();
		const first = new TerminalProgress({ enabled: true, write: sink.write });
		const second = new TerminalProgress({ enabled: true, write: sink.write });
		first.set();
		// The second never set it, so its clear is a no-op and the first still owns
		// the indicator.
		assert.equal(second.clear(), false);
		assert.equal(first.active, true);
		assert.equal(second.active, false);
		assert.deepEqual(sink.written, [PROGRESS_BEGIN]);
	});

	it("a shutdown may clear unconditionally, because a spinner must not outlive the process", () => {
		const sink = recorder();
		const progress = new TerminalProgress({ enabled: true, write: sink.write });
		progress.set();
		progress.clearOnExit();
		assert.equal(progress.active, false);
		assert.deepEqual(sink.written, [PROGRESS_BEGIN, PROGRESS_END]);
	});

	it("a shutdown on an unowned indicator writes nothing", () => {
		const sink = recorder();
		const progress = new TerminalProgress({ enabled: true, write: sink.write });
		progress.clearOnExit();
		assert.deepEqual(sink.written, []);
	});
});

describe("it is off until asked", () => {
	it("writes nothing when disabled", () => {
		// The sequence reaches outside the render loop, so a session that emits it on
		// an unexpected path would clear a spinner during an unrelated turn.
		const sink = recorder();
		const progress = new TerminalProgress({ enabled: false, write: sink.write });
		assert.equal(progress.set(), false);
		assert.deepEqual(sink.written, []);
	});
});

describe("capability is guessed, never probed", () => {
	it("recognises a terminal known to render it", () => {
		assert.equal(terminalSupportsProgress("WezTerm"), true);
		assert.equal(terminalSupportsProgress("vscode"), true);
	});

	it("does not guess for an unknown or absent terminal", () => {
		// A probe is itself an escape sequence, and one that reaches a terminal which
		// does not support it leaves a stray character in the transcript.
		assert.equal(terminalSupportsProgress("xterm-256color"), false);
		assert.equal(terminalSupportsProgress(undefined), false);
		assert.equal(terminalSupportsProgress(""), false);
	});

	it("says what the sequence does, and what it will do here", () => {
		assert.ok(describeProgress(true).includes("taskbar"));
		assert.ok(describeProgress(false).includes("ignored"));
	});
});
