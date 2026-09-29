/**
 * Image URL lifetime: when a locally served image link stops working.
 *
 * ## Why images are served by URL at all
 *
 * Several providers accept images by reference rather than inline, and a large
 * image sent inline with every turn is both expensive and redundant. Publishing
 * it once and passing a link turns a per-turn cost into a one-off.
 *
 * That makes the link's lifetime a correctness question, not a housekeeping one:
 * a link that dies while a conversation still refers to it breaks that
 * conversation, and the error the model sees is an opaque 404 on a URL it never
 * chose.
 *
 * ## Two independent expiry rules
 *
 * A blob expires when **either** says so:
 *
 * 1. **The publication's own `expiresAt`**, when the destination reports one -
 *    a cloud drive that revokes a share, a signed URL that lapses. That clock is
 *    not ours, and it is authoritative for its own link.
 * 2. **The TTL since `touchedAt`**, which is the local window. `touchedAt` is
 *    updated every time a conversation *sends* the link, so a conversation that
 *    is still using an image keeps it alive, and resuming that conversation
 *    re-arms the window at the same link rather than issuing a new one.
 *
 * ## `0` means "while the broker runs"
 *
 * A zero TTL disables local expiry entirely. That is a deliberate choice, not a
 * missing default: a user serving images to a long-lived machine may want links
 * that outlive any window, and the broker's own shutdown still reaps them.
 */

import { createHash } from "node:crypto";

/** A published image, and everything its lifetime depends on. */
export interface PublishedImage {
	/** The token in the URL. */
	readonly token: string;
	/** The content hash, so the same bytes publish once. */
	readonly contentHash: string;
	/** Bytes resident in memory, or 0 when evicted. */
	readonly bytes: number;
	readonly publishedAtMs: number;
	/** When a conversation last *sent* this link. Re-armed on every send. */
	readonly touchedAtMs: number;
	/** The destination's own expiry, when it reports one. Never ours to extend. */
	readonly expiresAtMs?: number;
	/** Conversations currently referring to this link. */
	readonly referencedBy: readonly string[];
}

/** Lifetime configuration. */
export interface ImageLifetimeConfig {
	/**
	 * Hours a link survives since it was last sent.
	 *
	 * `0` keeps links alive for as long as the broker runs.
	 */
	readonly ttlHours: number;
}

/** Whether a link is still usable, and why. */
export type ExpiryVerdict =
	| { readonly expired: false }
	| { readonly expired: true; readonly reason: "destination-expiry" | "local-ttl" };

/**
 * Whether a link has expired.
 *
 * The destination's own clock is checked first and independently: a signed URL
 * that lapses is dead whether or not our window has elapsed, and a local window
 * cannot resurrect it.
 */
export function isExpired(image: PublishedImage, nowMs: number, config: ImageLifetimeConfig): ExpiryVerdict {
	if (image.expiresAtMs !== undefined && nowMs >= image.expiresAtMs) {
		return { expired: true, reason: "destination-expiry" };
	}
	// Zero keeps links alive for as long as the broker runs, and disposal at
	// shutdown is what reaps them.
	if (config.ttlHours <= 0) return { expired: false };
	const ttlMs = config.ttlHours * 3_600_000;
	if (nowMs - image.touchedAtMs > ttlMs) {
		return { expired: true, reason: "local-ttl" };
	}
	return { expired: false };
}

/** The absolute local deadline for a link, for a status line. */
export function localDeadlineMs(image: PublishedImage, config: ImageLifetimeConfig): number | undefined {
	if (config.ttlHours <= 0) return undefined;
	return image.touchedAtMs + config.ttlHours * 3_600_000;
}

/** The remaining life of a link, for a user-facing notice. */
export function remainingMs(image: PublishedImage, nowMs: number, config: ImageLifetimeConfig): number | undefined {
	const local = localDeadlineMs(image, config);
	// The destination's clock can be nearer than ours, and it wins.
	if (image.expiresAtMs !== undefined) {
		const destinationRemaining = image.expiresAtMs - nowMs;
		if (local === undefined) return Math.max(0, destinationRemaining);
		return Math.max(0, Math.min(local - nowMs, destinationRemaining));
	}
	return local === undefined ? undefined : Math.max(0, local - nowMs);
}

/**
 * The link token for a content hash.
 *
 * Derived rather than random, so the same bytes always yield the same link - even
 * after the entry has been swept. A conversation resuming with a URL it already
 * holds must find it again, and a random token would make that a dead link.
 */
function contentToken(contentHash: string): string {
	return contentHash.slice(0, 32);
}

/** A URL minted for a published image. */
export function buildImageUrl(input: { bindHost: string; publicBaseUrl?: string; token: string }): string {
	// An explicit public base wins: it is how a user publishes a broker bound to
	// localhost behind a tunnel, and ignoring it would hand out an unreachable host.
	const base = input.publicBaseUrl?.trim() || `http://${input.bindHost}`;
	const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
	return `${normalized}/image/${input.token}`;
}

/** Tokens in memory for one broker. */
export class ImageBroker {
	readonly #images = new Map<string, PublishedImage>();
	readonly #tokenByHash = new Map<string, string>();
	readonly #config: ImageLifetimeConfig;
	#residentBytes = 0;
	readonly #maxResidentBytes: number;

	constructor(config: ImageLifetimeConfig, options: { maxResidentBytes?: number } = {}) {
		this.#config = config;
		// A bounded cache: an image broker that never evicts is a memory leak with
		// a URL in front of it.
		this.#maxResidentBytes = options.maxResidentBytes ?? 256 * 1024 * 1024;
	}

	/** Bytes currently resident. */
	get residentBytes(): number {
		return this.#residentBytes;
	}

	get size(): number {
		return this.#images.size;
	}

	/**
	 * Publishes an image, reusing the link for identical bytes.
	 *
	 * The same bytes publishing twice would give the same conversation two links
	 * to the same content, and the first would expire while the second did not.
	 */
	publish(input: { content: Uint8Array; nowMs: number; conversationId?: string }): PublishedImage {
		// Expired links are dropped first so a re-publish of the same bytes mints the
		// same token again: a conversation resuming with a link it already holds
		// must get that link back, not a new one it has never seen.
		this.sweep(input.nowMs);
		const contentHash = createHash("sha256").update(input.content).digest("hex");
		const existingToken = this.#tokenByHash.get(contentHash);
		if (existingToken) {
			const existing = this.#images.get(existingToken)!;
			const touched = this.#touch(existing, input.conversationId, input.nowMs);
			// Revived: the bytes may have been evicted, so they come back resident.
			if (touched.bytes === 0) {
				this.#residentBytes += input.content.byteLength;
				this.#images.set(existingToken, { ...touched, bytes: input.content.byteLength });
			}
			return this.#images.get(existingToken)!;
		}
		const image: PublishedImage = {
			token: contentToken(contentHash),
			contentHash,
			bytes: input.content.byteLength,
			publishedAtMs: input.nowMs,
			touchedAtMs: input.nowMs,
			referencedBy: input.conversationId ? [input.conversationId] : [],
		};
		this.#images.set(image.token, image);
		this.#tokenByHash.set(contentHash, image.token);
		this.#residentBytes += image.bytes;
		this.#evictIfNeeded(image.token);
		return image;
	}

	/**
	 * Records that a conversation sent this link, re-arming the window.
	 *
	 * This is what makes a resumed conversation keep the links it already used,
	 * rather than failing on images that were perfectly valid when it was written.
	 */
	send(token: string, conversationId: string, nowMs: number): PublishedImage | undefined {
		const image = this.#images.get(token);
		if (!image) return undefined;
		const touched = this.#touch(image, conversationId, nowMs);
		this.#images.set(token, touched);
		return touched;
	}

	#touch(image: PublishedImage, conversationId: string | undefined, nowMs: number): PublishedImage {
		return {
			...image,
			touchedAtMs: nowMs,
			referencedBy:
				conversationId && !image.referencedBy.includes(conversationId)
					? [...image.referencedBy, conversationId]
					: image.referencedBy,
		};
	}

	get(token: string): PublishedImage | undefined {
		return this.#images.get(token);
	}

	/** Expired links, for a user-facing notice rather than a silent 404. */
	expired(nowMs: number): { token: string; reason: string }[] {
		const out: { token: string; reason: string }[] = [];
		for (const image of this.#images.values()) {
			const verdict = isExpired(image, nowMs, this.#config);
			if (verdict.expired) out.push({ token: image.token, reason: verdict.reason });
		}
		return out;
	}

	/** Drops expired links and returns what went. */
	sweep(nowMs: number): { token: string; reason: string }[] {
		const dropped: { token: string; reason: string }[] = [];
		for (const [token, image] of this.#images) {
			const verdict = isExpired(image, nowMs, this.#config);
			if (verdict.expired) {
				this.#remove(token, image);
				dropped.push({ token, reason: verdict.reason });
			}
		}
		return dropped;
	}

	/**
	 * Reaps everything, at broker shutdown.
	 *
	 * Independent of the TTL, exactly as a zero TTL still reaps: a link that
	 * outlives the process serving it is unreachable rather than merely unused.
	 */
	dispose(): number {
		const count = this.#images.size;
		for (const [token, image] of this.#images) this.#remove(token, image);
		return count;
	}

	#remove(token: string, image: PublishedImage): void {
		this.#residentBytes -= image.bytes;
		this.#images.delete(token);
		this.#tokenByHash.delete(image.contentHash);
	}

	/** Evicts the least recently sent image when the cache is over budget. */
	#evictIfNeeded(protectedToken: string): void {
		if (this.#residentBytes <= this.#maxResidentBytes) return;
		let oldestToken: string | undefined;
		let oldestTouched = Number.POSITIVE_INFINITY;
		for (const [token, image] of this.#images) {
			if (token === protectedToken) continue;
			if (image.touchedAtMs < oldestTouched) {
				oldestTouched = image.touchedAtMs;
				oldestToken = token;
			}
		}
		// LRU by *send* time, not by publication time: an image a conversation is
		// still using is the one to keep.
		if (oldestToken) {
			const image = this.#images.get(oldestToken)!;
			// Only the *bytes* are evicted. The link stays, because a conversation
			// that still refers to it must find a working image rather than a dead
			// URL: re-publishing the same bytes re-arms the link and restores them.
			this.#residentBytes -= image.bytes;
			this.#images.set(oldestToken, { ...image, bytes: 0 });
		}
	}
}
