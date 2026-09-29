/**
 * Isolation backends: how a subagent gets its own copy-on-write view.
 *
 * ## The backend is an implementation detail, the setting is not
 *
 * There are eight copy-on-write mechanisms, each native to one filesystem or
 * platform. They are grouped into three *classes*, and the classes are what
 * actually differ in behaviour:
 *
 * - **Reflink** — a true copy-on-write clone. Instant, and the clone is fully
 *   independent from the moment it exists. APFS, btrfs, ZFS, and Linux reflink
 *   all land here.
 * - **Overlay** — a stacked view over a lower directory. Cheap to create, but
 *   the upper layer must be writable and the mount may not be available in a
 *   container, so it is not universally usable.
 * - **Copy** — a real copy. Correct everywhere and slow everywhere, and it is
 *   the only class with no prerequisites.
 *
 * ## Falling back is normal, and it is reported
 *
 * A preferred backend that is unavailable downgrades to the next candidate, and
 * the result carries `fellBack` with a reason. That flag is not diagnostic
 * detail — a caller that assumed a reflink and got a full copy has a materially
 * different latency profile and needs to be able to say so.
 *
 * The preference order therefore runs within a class before crossing to the
 * next: on a btrfs volume, btrfs is tried before APFS even though APFS is listed
 * first, because both are reflinks and the native one is faster.
 *
 * ## `auto` is not "pick anything"
 *
 * Auto runs the same ordered probe as an explicit request. The difference is
 * only that it starts from the platform's own best candidate rather than from
 * the first entry, so an explicit choice is never silently reordered.
 */

/** A copy-on-write mechanism, grouped by behaviour class. */
export type IsolationBackend = "apfs" | "btrfs" | "zfs" | "reflink" | "overlayfs" | "projfs" | "block-clone" | "rcopy";

/** What actually differs between backends. */
export type BackendClass = "reflink" | "overlay" | "copy";

interface BackendInfo {
	readonly label: string;
	readonly class: BackendClass;
	/** Probe name, for reporting. */
	readonly probe: string;
}

const BACKENDS: Readonly<Record<IsolationBackend, BackendInfo>> = {
	apfs: { label: "APFS", class: "reflink", probe: "clonefile" },
	btrfs: { label: "Btrfs", class: "reflink", probe: "ioctl FICLONE" },
	zfs: { label: "ZFS", class: "reflink", probe: "clone_range" },
	reflink: { label: "Linux reflink", class: "reflink", probe: "FICLONE" },
	overlayfs: { label: "OverlayFS", class: "overlay", probe: "lowerdir" },
	projfs: { label: "ProjFS", class: "overlay", probe: "ProjFS" },
	"block-clone": { label: "Windows block clone", class: "copy", probe: "FSCTL_DUPLICATE" },
	rcopy: { label: "Recursive copy", class: "copy", probe: "copy" },
};

/**
 * Probe order, most-preferred first.
 *
 * Reflinks first because they are instant and fully independent. Overlay
 * second. Copy last, because it is the only class with no prerequisites and so
 * is the guaranteed answer rather than a good one.
 */
export const ISOLATION_BACKEND_ORDER: readonly IsolationBackend[] = [
	"apfs",
	"btrfs",
	"zfs",
	"reflink",
	"overlayfs",
	"projfs",
	"block-clone",
	"rcopy",
];

/** The backends in a class, in preference order. */
export function backendsOfClass(backendClass: BackendClass): IsolationBackend[] {
	return ISOLATION_BACKEND_ORDER.filter((backend) => BACKENDS[backend].class === backendClass);
}

/** What class a backend belongs to. */
export function classOf(backend: IsolationBackend): BackendClass {
	return BACKENDS[backend].class;
}

/** A display label for a backend. */
export function labelFor(backend: IsolationBackend): string {
	return BACKENDS[backend].label;
}

/** Whether a value names a supported backend. */
export function isIsolationBackend(value: unknown): value is IsolationBackend {
	return typeof value === "string" && Object.hasOwn(BACKENDS, value);
}

/** What a probe found. */
export interface IsolationHandle {
	/** The merged view handed to the task. */
	readonly mergedDir: string;
	readonly backend: IsolationBackend;
	/** True when the resolver downgraded from the preferred backend. */
	readonly fellBack: boolean;
	/** Why it downgraded, or null when it did not. */
	readonly fallbackReason: string | null;
}

/**
 * Orders candidates for a request.
 *
 * An explicit backend is tried **first and alone in its class before any other
 * class is entered**, so on a btrfs volume an explicit `btrfs` beats an explicit
 * `apfs` even though APFS is listed first. Auto starts from the platform's own
 * best candidate instead, so an explicit choice is never silently reordered.
 */
export function candidateOrder(
	preferred: IsolationBackend | "auto",
	available: readonly IsolationBackend[],
): IsolationBackend[] {
	const usable = ISOLATION_BACKEND_ORDER.filter((backend) => available.includes(backend));
	if (preferred === "auto") return usable;
	// follows in global order. A class boundary is crossed only after the chosen one
	// is exhausted, so falling back from an unavailable reflink reaches another
	// reflink rather than a full copy.
	const sameClass = backendsOfClass(classOf(preferred)).filter((backend) => usable.includes(backend));
	const restOfClass = sameClass.filter((backend) => backend !== preferred);
	// A preference that is not available at all contributes nothing to lead with; the
	// rest of the order is still correct, so the call degrades rather than failing.
	return usable.includes(preferred)
		? [preferred, ...restOfClass, ...usable.filter((backend) => !sameClass.includes(backend))]
		: usable;
}

/**
 * Probes for the first usable backend.
 *
 * Returns the handle with `fellBack` set whenever the chosen backend is not the
 * one that was asked for. That flag is not diagnostic detail: a caller that
 * assumed a reflink and received a full copy has a materially different latency
 * profile and has to be able to say so.
 */
export function resolveIsolationBackend(input: {
	readonly preferred: IsolationBackend | "auto";
	readonly available: readonly IsolationBackend[];
	/** Invoked per candidate; a truthy return means the probe failed. */
	readonly probe: (backend: IsolationBackend) => string | undefined;
	readonly mergedDir: string;
}): IsolationHandle {
	const ordered = candidateOrder(input.preferred, input.available);
	// Why each candidate was rejected, so the fallback can name the real cause. The
	// preferred backend's own failure is the one that matters; the rest are only
	// interesting when nothing works.
	const failures = new Map<IsolationBackend, string>();
	for (const backend of ordered) {
		const failure = input.probe(backend);
		if (failure !== undefined) {
			failures.set(backend, failure);
			continue;
		}
		const fellBack = input.preferred !== "auto" && backend !== input.preferred;
		// Naming the *preferred* backend's failure, not the successful one's: on the
		// success path there is no failure to report, and reporting the absence of one
		// would read as "apfs is unavailable: undefined".
		const reason = input.preferred !== "auto" ? failures.get(input.preferred) : undefined;
		return {
			mergedDir: input.mergedDir,
			backend,
			fellBack,
			fallbackReason: fellBack
				? `${input.preferred} is unavailable: ${reason ?? "not available on this platform"}`
				: null,
		};
	}
	// No backend works. rcopy has no prerequisites, so this only happens when it is
	// absent from `available` or its own probe failed, both of which are worth a
	// distinct error rather than a silent empty result.
	throw new Error(
		ordered.length === 0
			? "No isolation backend is available on this platform"
			: `No isolation backend could be created: ${ordered.map((b) => `${b} (${BACKENDS[b].probe})`).join(", ")}`,
	);
}
