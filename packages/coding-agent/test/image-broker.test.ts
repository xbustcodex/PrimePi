import { describe, expect, it } from "vitest";
import {
	buildImageUrl,
	ImageBroker,
	type ImageLifetimeConfig,
	isExpired,
	localDeadlineMs,
	remainingMs,
} from "../src/core/images/image-broker.ts";

/**
 * Image URL lifetime.
 *
 * The properties that matter: a conversation still using an image keeps it
 * alive, a destination's own clock is authoritative over ours, and a zero TTL
 * disables local expiry without disabling disposal.
 */

const HOUR = 3_600_000;
const config = (ttlHours: number): ImageLifetimeConfig => ({ ttlHours });
const bytes = (size: number, fill = 65) => new Uint8Array(size).fill(fill);

describe("expiry is decided by two independent clocks", () => {
	it("honours the destination's own expiry", () => {
		// A signed URL that lapses is dead whether or not our window has elapsed.
		const image = {
			token: "t",
			contentHash: "h",
			bytes: 10,
			publishedAtMs: 0,
			touchedAtMs: 0,
			expiresAtMs: 1000,
			referencedBy: [],
		};
		expect(isExpired(image, 500, config(72))).toEqual({ expired: false });
		expect(isExpired(image, 1500, config(72))).toEqual({ expired: true, reason: "destination-expiry" });
	});

	it("honours the local ttl since the last send", () => {
		const image = {
			token: "t",
			contentHash: "h",
			bytes: 10,
			publishedAtMs: 0,
			touchedAtMs: 10 * HOUR,
			referencedBy: [],
		};
		expect(isExpired(image, 10 * HOUR, config(24)).expired).toBe(false);
		expect(isExpired(image, 40 * HOUR, config(24))).toEqual({ expired: true, reason: "local-ttl" });
	});

	it("keeps links alive at a zero ttl", () => {
		// A user serving images to a long-lived machine may want links that outlive
		// any window; shutdown is what reaps them.
		const image = {
			token: "t",
			contentHash: "h",
			bytes: 10,
			publishedAtMs: 0,
			touchedAtMs: 0,
			referencedBy: [],
		};
		expect(isExpired(image, 100_000 * HOUR, config(0))).toEqual({ expired: false });
		expect(localDeadlineMs(image, config(0))).toBeUndefined();
	});

	it("reports the nearer of the two clocks as the remaining life", () => {
		const base = {
			token: "t",
			contentHash: "h",
			bytes: 10,
			publishedAtMs: 0,
			touchedAtMs: 0,
			referencedBy: [] as string[],
		};
		// The destination's clock can be nearer than ours, and it wins.
		expect(remainingMs({ ...base, expiresAtMs: 2 * HOUR }, 0, config(72))).toBe(2 * HOUR);
		expect(remainingMs({ ...base, expiresAtMs: 100 * HOUR }, 0, config(72))).toBe(72 * HOUR);
		expect(remainingMs(base, 0, config(0))).toBeUndefined();
	});
});

describe("URLs", () => {
	it("uses the bind host by default", () => {
		expect(buildImageUrl({ bindHost: "127.0.0.1:8080", token: "abc" })).toBe("http://127.0.0.1:8080/image/abc");
	});

	it("prefers an explicit public base", () => {
		// That is how a user publishes a broker bound to localhost behind a tunnel,
		// and ignoring it would hand out an unreachable host.
		expect(buildImageUrl({ bindHost: "127.0.0.1:8080", publicBaseUrl: "https://cdn.example/", token: "abc" })).toBe(
			"https://cdn.example/image/abc",
		);
	});

	it("ignores a blank public base rather than producing a root-relative url", () => {
		expect(buildImageUrl({ bindHost: "localhost:1", publicBaseUrl: "   ", token: "a" })).toBe(
			"http://localhost:1/image/a",
		);
	});
});

describe("the broker", () => {
	it("publishes once and reuses the link for identical bytes", () => {
		// The same bytes publishing twice would give one conversation two links to
		// the same content, and the first would expire while the second did not.
		const broker = new ImageBroker(config(72));
		const first = broker.publish({ content: bytes(100), nowMs: 0 });
		const second = broker.publish({ content: bytes(100), nowMs: 1000 });
		expect(second.token).toBe(first.token);
		expect(broker.size).toBe(1);
	});

	it("re-arms the window when a conversation sends the link", () => {
		// This is what makes a resumed conversation keep the links it already used,
		// rather than failing on images that were valid when it was written.
		const broker = new ImageBroker(config(24));
		const image = broker.publish({ content: bytes(100), nowMs: 0, conversationId: "c1" });
		// 30 hours later the local window would have closed...
		expect(isExpired(broker.get(image.token)!, 30 * HOUR, config(24)).expired).toBe(true);
		// ...but the conversation sent it, so the clock restarts.
		broker.send(image.token, "c1", 30 * HOUR);
		expect(isExpired(broker.get(image.token)!, 30 * HOUR, config(24)).expired).toBe(false);
	});

	it("tracks which conversations refer to a link", () => {
		const broker = new ImageBroker(config(24));
		const image = broker.publish({ content: bytes(10), nowMs: 0, conversationId: "c1" });
		broker.send(image.token, "c2", 10);
		expect([...broker.get(image.token)!.referencedBy].sort()).toEqual(["c1", "c2"]);
	});

	it("ignores a send for a link it does not have", () => {
		// A send can race a sweep, and that is not an error worth propagating.
		const broker = new ImageBroker(config(24));
		expect(broker.send("missing", "c1", 0)).toBeUndefined();
	});

	it("sweeps expired links and reports why", () => {
		const broker = new ImageBroker(config(1));
		const image = broker.publish({ content: bytes(10), nowMs: 0 });
		expect(broker.sweep(2 * HOUR)).toEqual([{ token: image.token, reason: "local-ttl" }]);
		expect(broker.get(image.token)).toBeUndefined();
	});

	it("lists expired links without dropping them, for a user-facing notice", () => {
		// A silent 404 on a link the model never chose is the failure this avoids.
		const broker = new ImageBroker(config(1));
		const image = broker.publish({ content: bytes(10), nowMs: 0 });
		expect(broker.expired(2 * HOUR)).toEqual([{ token: image.token, reason: "local-ttl" }]);
		expect(broker.get(image.token)).toBeDefined();
	});

	it("reaps everything at dispose, even at a zero ttl", () => {
		// A link that outlives the process serving it is unreachable rather than
		// merely unused.
		const broker = new ImageBroker(config(0));
		broker.publish({ content: bytes(10), nowMs: 0 });
		broker.publish({ content: bytes(20), nowMs: 0 });
		expect(broker.dispose()).toBe(2);
		expect(broker.size).toBe(0);
		expect(broker.residentBytes).toBe(0);
	});

	it("reuses a link after a sweep, re-arming it", () => {
		const broker = new ImageBroker(config(1));
		const content = bytes(100);
		const first = broker.publish({ content, nowMs: 0 });
		broker.sweep(5 * HOUR);
		// Identical bytes publish the same link again rather than minting a new one
		// the conversation has never seen.
		const again = broker.publish({ content, nowMs: 5 * HOUR });
		expect(again.token).toBe(first.token);
	});

	it("evicts the bytes of the least recently sent image, keeping the link", () => {
		// LRU by *send* time, not publication time: an image a conversation is still
		// using is the one to keep. Eviction drops the bytes, not the link, because a
		// conversation still referring to it must find a working image rather than a
		// dead URL.
		const broker = new ImageBroker(config(72), { maxResidentBytes: 300 });
		const first = broker.publish({ content: bytes(200), nowMs: 0 });
		const second = broker.publish({ content: bytes(200, 66), nowMs: 1000 });
		expect(broker.residentBytes).toBeLessThanOrEqual(300);
		expect(broker.get(first.token)!.bytes).toBe(0);
		// The more recently sent image keeps its bytes.
		expect(broker.get(second.token)!.bytes).toBe(200);
		// And re-publishing the evicted content restores them under the same link.
		expect(broker.publish({ content: bytes(200), nowMs: 2000 }).token).toBe(first.token);
		expect(broker.get(first.token)!.bytes).toBe(200);
	});
});
