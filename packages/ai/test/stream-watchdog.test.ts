import { describe, expect, it } from "vitest";
import {
	describeTimeout,
	parseTimeoutSeconds,
	TIMEOUT_AUTO,
	timeoutSecondsToMs,
	withStreamWatchdog,
	withWatchdogFetch,
} from "../src/utils/stream-watchdog.ts";

/**
 * Stream watchdogs.
 *
 * These use real short timers rather than fake ones, because the property under
 * test *is* timing: a watchdog that never fires is indistinguishable from one
 * that was written correctly and never armed.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A stream that emits `chunks` and then stays open.
 *
 * Staying open is the point: a watchdog is only observable on a stream that
 * never ends on its own, which is exactly the failure it exists for. Callers
 * that need an ending pass `close: true`.
 */
function openStream(chunks: string[], gapMs = 0, close = false): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
				controller.enqueue(encoder.encode(chunk));
			}
			if (close) controller.close();
		},
	});
}

/** Drains a stream, resolving when it ends or when `abort` fires. */
async function drain(
	stream: ReadableStream<Uint8Array>,
	abort: { current: boolean },
	onChunk?: (text: string) => void,
): Promise<string> {
	const reader = stream.getReader();
	const parts: string[] = [];
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const text = decoder.decode(value);
			parts.push(text);
			onChunk?.(text);
		}
	} catch {
		// A watchdog erroring the stream is the expected termination.
	}
	abort.current = true;
	return parts.join("");
}

describe("the three settings are distinct", () => {
	it("treats a negative or non-finite value as auto", () => {
		// A hard-coded constant would override whatever the provider or operator
		// configured, so *auto* is the default and is deliberately not a number.
		expect(timeoutSecondsToMs(TIMEOUT_AUTO)).toBeUndefined();
		expect(timeoutSecondsToMs(-5)).toBeUndefined();
		expect(timeoutSecondsToMs(Number.NaN)).toBeUndefined();
	});

	it("treats zero as disabled rather than as an instant abort", () => {
		// A zero deadline would abort every request, so a user who turned the
		// watchdog off gets silence rather than an error.
		expect(timeoutSecondsToMs(0)).toBe(0);
	});

	it("converts a positive value, never below one millisecond", () => {
		expect(timeoutSecondsToMs(30)).toBe(30_000);
		expect(timeoutSecondsToMs(0.0001)).toBe(1);
	});

	it("reads the string form a settings file holds", () => {
		expect(parseTimeoutSeconds("45")).toBe(45);
		expect(parseTimeoutSeconds(" 0 ")).toBe(0);
		expect(parseTimeoutSeconds("auto")).toBe(TIMEOUT_AUTO);
		expect(parseTimeoutSeconds(undefined)).toBe(TIMEOUT_AUTO);
	});

	it("describes the state for a status line", () => {
		expect(describeTimeout(-1)).toBe("auto");
		expect(describeTimeout(0)).toBe("disabled");
		expect(describeTimeout(12)).toBe(12);
	});
});

describe("no watchdog when auto or disabled", () => {
	it("passes the stream through untouched", async () => {
		const abort = { current: false };
		const source = openStream(["a", "b"], 0, true);
		const guarded = withStreamWatchdog(source, {
			firstEventTimeoutMs: undefined,
			idleTimeoutMs: 0,
			onTimeout: () => {
				throw new Error("must not fire");
			},
		});
		expect(guarded).toBe(source);
		expect(await drain(guarded, abort)).toBe("ab");
	});
});

describe("the first-event watchdog", () => {
	it("fires when no event arrives", async () => {
		const abort = { current: false };
		let fired: string | undefined;
		let waited = 0;
		const guarded = withStreamWatchdog(openStream([]), {
			firstEventTimeoutMs: 40,
			idleTimeoutMs: undefined,
			onTimeout: (kind, ms) => {
				fired = kind;
				waited = ms;
			},
		});
		// The stream never ends on its own, so the drain resolves when the test
		// stops waiting - which is itself the proof that nothing was emitted.
		setTimeout(() => {
			void drain(guarded, abort).catch(() => {});
		}, 0);
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(fired).toBe("first-event");
		expect(waited).toBeGreaterThanOrEqual(30);
	});

	it("does not fire the first-event watchdog once an event has arrived", async () => {
		const abort = { current: false };
		const fired: string[] = [];
		// A generous first-event budget against a fast first chunk: the point of the
		// case is that the watchdog is *disarmed* after the first event, not that
		// it is slow, so the margins are wide enough not to be a timing race.
		const guarded = withStreamWatchdog(openStream(["a", "b", "c"], 5, true), {
			firstEventTimeoutMs: 400,
			idleTimeoutMs: undefined,
			onTimeout: (kind) => fired.push(kind),
		});
		await drain(guarded, abort);
		await new Promise((resolve) => setTimeout(resolve, 80));
		// The first event arrived, so the first-event budget is spent and the
		// watchdog is disarmed even though the stream has since closed.
		expect(fired).toEqual([]);
	});
});

describe("the idle watchdog", () => {
	it("fires when a running stream goes silent", async () => {
		const abort = { current: false };
		let fired: string | undefined;
		const guarded = withStreamWatchdog(openStream(["a", "b"], 5), {
			firstEventTimeoutMs: undefined,
			idleTimeoutMs: 40,
			onTimeout: (kind) => {
				fired = kind;
			},
		});
		void drain(guarded, abort);
		await new Promise((resolve) => setTimeout(resolve, 150));
		// The chunks arrived and then the stream went quiet, which is the failure
		// this watchdog exists for.
		expect(fired).toBe("idle");
	});

	it("does not fire while a stream keeps emitting", async () => {
		const abort = { current: false };
		const firedAt: number[] = [];
		const started = Date.now();
		// Eight chunks every 20ms: the whole run is longer than the 60ms budget,
		// but no single *gap* is. The budget is per gap, not per request, so a long
		// healthy generation is never touched.
		const guarded = withStreamWatchdog(openStream(["a", "b", "c", "d", "e", "f", "g", "h"], 20), {
			firstEventTimeoutMs: undefined,
			idleTimeoutMs: 60,
			onTimeout: (_kind, _ms) => firedAt.push(Date.now() - started),
		});
		void drain(guarded, abort);
		await new Promise((resolve) => setTimeout(resolve, 130));
		// Nothing fired during the run, even though the elapsed time already
		// exceeded the timeout twice over.
		expect(firedAt).toEqual([]);
	});

	it("reports once, not once per armed timer", async () => {
		const abort = { current: false };
		let count = 0;
		const guarded = withStreamWatchdog(openStream(["a"], 5), {
			firstEventTimeoutMs: 30,
			idleTimeoutMs: 30,
			onTimeout: () => {
				count += 1;
			},
		});
		void drain(guarded, abort);
		await new Promise((resolve) => setTimeout(resolve, 150));
		// Both watchdogs are armed; one stall is one failure, not two.
		expect(count).toBe(1);
	});
});

describe("withWatchdogFetch", () => {
	/** A body that emits `head` and then never ends, released by the caller. */
	function openBody(head: string): { body: ReadableStream<Uint8Array>; finish: () => void } {
		let finish = (): void => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(head));
				finish = () => {
					try {
						controller.enqueue(encoder.encode("done"));
						controller.close();
					} catch {}
				};
			},
		});
		return { body, finish: () => finish() };
	}

	it("returns null when nothing is armed, so an unset fetch stays unset", () => {
		expect(withWatchdogFetch(undefined, {})).toBeNull();
		// Zero is *disabled*, not "fire immediately" (see the three-states note).
		expect(withWatchdogFetch(undefined, { idleTimeoutMs: 0, firstEventTimeoutMs: 0 })).toBeNull();
	});

	it("errors the body with a message naming the setting, and never a credential", async () => {
		const source = openBody("head");
		const guardedFetch = withWatchdogFetch(async () => new Response(source.body), { idleTimeoutMs: 20 });
		expect(guardedFetch).not.toBeNull();
		const response = await (guardedFetch as typeof globalThis.fetch)("https://example.invalid/v1");
		const reader = response.body!.getReader();
		await reader.read();

		const failure = await reader.read().then(
			(result) => (result.done ? new Error("stream ended instead of failing") : new Error("chunk arrived")),
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		const message = failure instanceof Error ? failure.message : "";
		expect(message).toContain("idle watchdog");
		expect(message).toContain("providers.streamIdleTimeoutSeconds");
		// The wrapper sits below the auth layer and never sees a header, so it has
		// nothing to leak; the assertion pins that rather than assuming it.
		expect(message).not.toMatch(/Bearer|sk-|api[-_]?key/i);
		source.finish();
	});

	it("passes a healthy stream through untouched when the budget is generous", async () => {
		const source = openBody("head");
		const guardedFetch = withWatchdogFetch(async () => new Response(source.body), { idleTimeoutMs: 5000 });
		const response = await (guardedFetch as typeof globalThis.fetch)("https://example.invalid/v1");
		const reader = response.body!.getReader();
		expect(await reader.read()).toMatchObject({ done: false });
		source.finish();
		const rest = await reader.read();
		expect(decoder.decode(rest.value)).toBe("done");
	});
});
