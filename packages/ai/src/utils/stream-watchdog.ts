/**
 * Stream watchdogs: bounding how long a model stream may stall.
 *
 * ## The failure
 *
 * A provider request that never produces an event hangs forever. The turn
 * never completes, the abort button is the only exit, and from the user's side
 * the session has simply stopped. There is no error and no trace, which is what
 * makes it worse than a failure: a failed request can be retried.
 *
 * Two separate bounds, because "no first event" and "silence in the middle" are
 * different failures with different costs. A first-event watchdog is generous —
 * some models think for a long time before emitting anything. An idle watchdog
 * is tight — once a stream is running, a long gap means it has ended without
 * saying so.
 *
 * ## The three states
 *
 * `-1` means *auto*: use the provider's own default, or the environment's. This
 * is the default and it is deliberately not a number, because a hard-coded
 * constant would override whatever the provider or operator configured.
 *
 * `0` means *disabled*. Not "immediate" — a zero timeout that aborted
 * instantly would make the watchdog fire on every request, and a user who
 * turned it off deserves silence rather than an error.
 *
 * A positive value is seconds, and the conversion is at least 1ms so a
 * fractional value cannot produce a zero deadline.
 *
 * ## Why the timer is refilled rather than absolute
 *
 * A deadline set once at the start of a request would abort a long but healthy
 * generation. The idle budget is per *gap*, not per request, so a stream that
 * emits steadily for ten minutes is never touched.
 */

import type { ReadableStream } from "node:stream/web";

/** Sentinel meaning "use the provider or environment default". */
export const TIMEOUT_AUTO = -1;

/** How a timeout setting is interpreted. */
export type StreamTimeoutSetting = "auto" | "disabled" | number;

/**
 * Converts a seconds-valued setting into a millisecond deadline.
 *
 * Returns `undefined` for *auto* and `0` for *disabled*, which the watchdog
 * treats as "no watchdog" in both cases — the difference is preserved only for
 * the diagnostics, where "inherited" and "explicitly off" are different facts.
 */
export function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/** Reads a seconds-valued setting, tolerating the string form settings files hold. */
export function parseTimeoutSeconds(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Number(raw.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return TIMEOUT_AUTO;
}

/** Classifies a setting for a status line, keeping the three states distinct. */
export function describeTimeout(value: number): StreamTimeoutSetting {
	if (!Number.isFinite(value) || value < 0) return "auto";
	if (value === 0) return "disabled";
	return value;
}

export interface WatchdogOptions {
	/** Milliseconds to wait for the first event, or `undefined`/`0` for no watchdog. */
	readonly firstEventTimeoutMs: number | undefined;
	/** Milliseconds a running stream may stay silent, or `undefined`/`0` for none. */
	readonly idleTimeoutMs: number | undefined;
	/** Called when a watchdog fires. */
	readonly onTimeout: (kind: "first-event" | "idle", waitedMs: number) => void;
}

/**
 * Wraps a byte stream with first-event and idle watchdogs.
 *
 * The returned stream is a `TransformStream` over the input, so a consumer sees
 * identical bytes and ordering. Watchdog state is per-call: two concurrent
 * streams never share a timer.
 */
export function withStreamWatchdog<T extends Uint8Array>(
	source: ReadableStream<T>,
	options: WatchdogOptions,
): ReadableStream<T> {
	const { firstEventTimeoutMs, idleTimeoutMs, onTimeout } = options;
	const firstEventArmed = typeof firstEventTimeoutMs === "number" && firstEventTimeoutMs > 0;
	const idleArmed = typeof idleTimeoutMs === "number" && idleTimeoutMs > 0;
	// Auto and disabled both mean "no watchdog"; the difference is kept for the
	// status line, not for behaviour.
	if (!firstEventArmed && !idleArmed) return source;

	const startedAt = Date.now();
	let firstEventSeen = false;
	// Held outside the transformer so every path clears the same timers.
	let firstEventTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;

	const clear = () => {
		if (firstEventTimer !== undefined) clearTimeout(firstEventTimer);
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		firstEventTimer = undefined;
		idleTimer = undefined;
	};

	const fire = (kind: "first-event" | "idle") => {
		// Latched: a stream that times out while its error propagates must report
		// once, or the consumer sees two failures for one stall.
		if (settled) return;
		settled = true;
		clear();
		onTimeout(kind, Date.now() - startedAt);
	};

	/** Refills both timers. The budget is per gap, not per request. */
	const refill = () => {
		if (settled) return;
		if (idleArmed) {
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => fire("idle"), idleTimeoutMs);
			// A watchdog that keeps the process alive would hang a shutdown.
			if (typeof idleTimer.unref === "function") idleTimer.unref();
		}
		if (!firstEventSeen && firstEventArmed) {
			if (firstEventTimer !== undefined) clearTimeout(firstEventTimer);
			firstEventTimer = setTimeout(() => fire("first-event"), firstEventTimeoutMs);
			if (typeof firstEventTimer.unref === "function") firstEventTimer.unref();
		}
	};

	refill();

	return source.pipeThrough(
		new TransformStream<T, T>({
			transform(chunk, controller) {
				firstEventSeen = true;
				controller.enqueue(chunk);
				refill();
			},
			flush() {
				clear();
			},
			cancel() {
				clear();
			},
		}),
	);
}
