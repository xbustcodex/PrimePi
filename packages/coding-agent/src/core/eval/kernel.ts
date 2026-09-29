/**
 * The Python kernel: whether it persists, and which interpreter runs it.
 *
 * ## Why a persistent kernel is worth the complexity
 *
 * Starting a Python process costs hundreds of milliseconds and loses every name
 * the last one defined. A session-scoped kernel lets a model's second snippet
 * reference what its first one built, which is the difference between an
 * assistant that can iterate on an analysis and one that rewrites itself each
 * time.
 *
 * The cost is that state the user cannot see persists between their calls. A
 * variable they can see in the transcript was set by code they did not write, and
 * a class redefined three calls ago is not the one they think it is. So the
 * choice is explicit rather than inferred, and it is stated in terms of what the
 * user loses, not only what they gain.
 *
 * ## `per-call` is not a performance knob
 *
 * With a fresh kernel per call, two snippets in one session cannot interfere:
 * no leftover variable, no monkey-patched import, no class mutated by an earlier
 * run. That is the property a user is buying when they choose it, and it is why
 * the setting is described as isolation rather than as slowness.
 *
 * ## The identity must include the interpreter
 *
 * A retained kernel is reused when the identity matches. Keyed on session alone,
 * a user who changes `python.interpreter` mid-session would silently keep talking
 * to the *old* interpreter, and a version-dependent result would be attributed to
 * the new one. The interpreter is part of the identity for the same reason the
 * working directory is.
 */

import { createHash } from "node:crypto";

/** Whether a kernel survives between calls. */
export type KernelMode = "session" | "per-call";

/** What identifies a retained kernel. */
export interface KernelIdentity {
	/** The working directory, which scopes what the kernel can reach. */
	readonly cwd: string;
	/** The session the kernel belongs to. */
	readonly sessionId: string;
	/** The configured interpreter, when one was named. */
	readonly interpreter?: string;
}

/** A stable key for a retained kernel. */
export function kernelKey(identity: KernelIdentity): string {
	// Every part is included: a kernel retained across an interpreter change is
	// the failure this prevents, and one retained across a working-directory
	// change sees a different filesystem.
	return createHash("sha256")
		.update(JSON.stringify([identity.cwd, identity.sessionId, identity.interpreter ?? ""]))
		.digest("hex")
		.slice(0, 32);
}

/** Whether two identities may share a kernel. */
export function isSameKernel(left: KernelIdentity, right: KernelIdentity): boolean {
	return kernelKey(left) === kernelKey(right);
}

export type KernelDecision =
	| { readonly action: "reuse"; readonly key: string; readonly reason: string }
	| { readonly action: "start"; readonly key: string; readonly reason: string }
	| { readonly action: "start-fresh"; readonly key: string; readonly reason: string };

/**
 * Decides what a Python call does to the kernel.
 *
 * `per-call` always starts fresh, which is the isolation the mode exists to
 * provide. `session` reuses a matching kernel and replaces a mismatched one,
 * because a kernel the caller did not ask for is worse than a slow one.
 */
export function decideKernel(input: {
	readonly mode: KernelMode;
	readonly identity: KernelIdentity;
	/** The key of a kernel already running, if any. */
	readonly runningKey?: string;
}): KernelDecision {
	const key = kernelKey(input.identity);
	if (input.mode === "per-call") {
		return {
			action: "start-fresh",
			key,
			// Isolation, not slowness: no leftover variable, no monkey-patched import,
			// no class mutated by an earlier run.
			reason: "per-call mode starts a fresh kernel, so two calls in one session cannot interfere",
		};
	}
	if (input.runningKey === key) {
		return { action: "reuse", key, reason: "a kernel with this identity is already running" };
	}
	if (input.runningKey !== undefined) {
		return {
			action: "start",
			key,
			// A kernel the caller did not ask for is worse than a slow one: it is
			// running an interpreter or a directory they have moved away from.
			reason: "the running kernel has a different identity, so it is replaced rather than reused",
		};
	}
	return { action: "start", key, reason: "no kernel is running for this session" };
}

/** One line for a settings hint, naming what the mode actually costs. */
export function describeKernelMode(mode: KernelMode): string {
	return mode === "session"
		? "The kernel survives between calls, so later snippets can use names earlier ones defined."
		: "Each call starts a fresh kernel, so nothing a previous call defined can affect this one.";
}

export type InterpreterResolution =
	| { readonly source: "configured"; readonly interpreter: string; readonly reason: string }
	| { readonly source: "discover"; readonly reason: string }
	| { readonly source: "unavailable"; readonly reason: string };

/**
 * Resolves which interpreter runs.
 *
 * A configured path **skips discovery entirely**, rather than being a candidate
 * discovery might prefer. A user who names an exact executable has said which
 * one, and a search that quietly substituted another would make every
 * version-dependent result unattributable.
 */
export function resolveInterpreter(input: {
	/** The configured path, if any. */
	readonly configured?: string;
	/** Whether discovery found something. */
	readonly discoverySucceeded: boolean;
}): InterpreterResolution {
	const configured = input.configured?.trim();
	if (configured) {
		return {
			source: "configured",
			interpreter: configured,
			reason: "a configured interpreter is used exactly, and discovery is skipped",
		};
	}
	if (input.discoverySucceeded) {
		return { source: "discover", reason: "no interpreter configured, so the discovered one is used" };
	}
	return {
		source: "unavailable",
		reason: "no interpreter configured and none was discovered, so Python evaluation is unavailable",
	};
}

/** Whether Python evaluation can run at all. */
export function pythonAvailable(resolution: InterpreterResolution): boolean {
	return resolution.source !== "unavailable";
}
