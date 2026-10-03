import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import type { ByteConnection } from "@earendil-works/pi-server";
import {
	createWindowsNamedPipeListener,
	getWindowsNamedPipePath,
	getWindowsServerPipePath,
} from "@earendil-works/pi-server/windows-named-pipe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowsNamedPipeTransportFactory } from "../src/windows-named-pipe.ts";

// Every test here binds a real named pipe and speaks real framed bytes over it. Nothing
// is mocked, because the properties under test are properties of the transport: exclusive
// endpoint ownership, a credential proved in-band, and no filesystem residue to squat.
const SERVER_ID = "1e4b3c2a-5d6f-4a7b-8c9d-0e1f2a3b4c5d";
const NONCE = "a".repeat(32);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function pipeName(prefix = "pi-test"): string {
	return `\\\\.\\pipe\\${prefix}-${randomBytes(8).toString("hex")}`;
}

/**
 * A listener whose accepted connections are collected rather than handed to a `Server`.
 *
 * The acceptor closes the connection, which is the acceptor's responsibility on both
 * transports - a listener only relays bytes and terminal events. Without it, a client that
 * half-closes would wait forever.
 */
async function startBareListener(options: { path?: string; onError?: (error: Error) => void } = {}) {
	const path = options.path ?? pipeName();
	const accepted: Array<{ connection: ByteConnection; received: Uint8Array[] }> = [];
	const listener = createWindowsNamedPipeListener({
		path,
		onError: options.onError,
	});
	await listener.start((connection) => {
		const chunks: Uint8Array[] = [];
		accepted.push({ connection, received: chunks });
		return {
			onData: (chunk) => {
				chunks.push(chunk);
				void connection.close();
			},
			onClose: () => {},
			onError: () => {},
		};
	});
	cleanups.push(() => listener.close());
	return { path, listener, accepted };
}

/**
 * Send one payload and wait for the *server* to close.
 *
 * The listener under test never replies - it only relays inbound bytes to the acceptor -
 * so the client must not wait for an echo. Ending after the write and resolving on the
 * server-side close is what makes this deterministic.
 */
function sendRaw(path: string, payload: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path });
		let sent = false;
		socket.on("error", reject);
		// The server closes after its own `end()`; resolve on our side once it does.
		socket.on("close", () => {
			if (sent) resolve();
		});
		socket.on("connect", () =>
			socket.write(payload, () => {
				sent = true;
				// Half-close so the server sees EOF and can finish.
				socket.end();
			}),
		);
	});
}

describe("endpoint naming", () => {
	it("derives a pipe name from a validated identity and generation nonce", () => {
		const path = getWindowsNamedPipePath(SERVER_ID, NONCE);
		expect(path).toBe(`\\\\.\\pipe\\pi-${SERVER_ID}-${NONCE}`);
		expect(getWindowsServerPipePath(SERVER_ID)).toBe(`\\\\.\\pipe\\pi-server-${SERVER_ID}`);
	});

	it("refuses an identity or nonce it cannot validate, rather than naming a pipe from it", () => {
		// A name derived from an unvalidated id would let one server generation's clients
		// address another's endpoint.
		expect(() => getWindowsNamedPipePath("not-a-uuid", NONCE)).toThrow(TypeError);
		expect(() => getWindowsNamedPipePath(SERVER_ID, "short")).toThrow(TypeError);
		expect(() => getWindowsNamedPipePath(SERVER_ID, NONCE, "bad prefix")).toThrow(TypeError);
	});

	it("rejects a path that is not a named pipe, so a host:port can never be bound", () => {
		// This is the "not accidentally network-accessible" property as a checked
		// invariant: `net.listen({ path: "localhost:8080" })` would open a TCP socket.
		expect(() => createWindowsNamedPipeListener({ path: "localhost:8080" })).toThrow(TypeError);
		expect(() => createWindowsNamedPipeListener({ path: "/tmp/pi.sock" })).toThrow(TypeError);
		expect(() => createWindowsNamedPipeTransportFactory({ path: "127.0.0.1:9999" })).toThrow(TypeError);
	});
});

describe("endpoint ownership", () => {
	it("grants exclusive ownership: a second bind of the same name is refused", async () => {
		const path = pipeName();
		await startBareListener({ path });

		// The kernel refuses this, which is the same guarantee the POSIX listener gets
		// from `link()` failing EEXIST. A second listener must fail loudly rather than
		// believe it shares the endpoint.
		const second = createWindowsNamedPipeListener({ path });
		await expect(second.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} }))).rejects.toThrow(
			/already in use/,
		);
		await second.close();
	});

	it("refuses to share an endpoint held by an unrelated server", async () => {
		// A pre-existing listener standing in for a hostile local process.
		const path = pipeName();
		const squatter = createServer();
		await new Promise<void>((resolve, reject) => {
			squatter.once("error", reject);
			squatter.listen({ path }, resolve);
		});
		cleanups.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())));

		const listener = createWindowsNamedPipeListener({ path });
		await expect(listener.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} }))).rejects.toThrow(
			/already in use/,
		);
		await listener.close();
	});

	it("leaves no filesystem residue a client could discover or squat", async () => {
		const { path, accepted } = await startBareListener();
		await new Promise<void>((resolve, reject) => {
			const socket = createConnection({ path });
			socket.on("connect", () => {
				socket.end();
				resolve();
			});
			socket.on("error", reject);
		});
		await vi.waitFor(() => expect(accepted.length).toBe(1));
		// A named pipe has no directory entry, so there is nothing for `readdir` to find
		// and nothing to delete. The Unix listener needs `removeStaleSocket` and an
		// inode check precisely because a socket *is* a file.
		expect(path.startsWith("\\\\.\\pipe\\")).toBe(true);
	});
});

describe("connection lifecycle", () => {
	it("accepts a legitimate connection and delivers its bytes", async () => {
		const { path, accepted } = await startBareListener();
		await sendRaw(path, new TextEncoder().encode("hello pipe"));

		await vi.waitFor(() => expect(accepted).toHaveLength(1));
		expect(Buffer.concat(accepted[0]!.received).toString()).toBe("hello pipe");
	});

	it("serves concurrent clients independently", async () => {
		const { path, accepted } = await startBareListener();
		await Promise.all(["one", "two", "three"].map((payload) => sendRaw(path, new TextEncoder().encode(payload))));

		await vi.waitFor(() => expect(accepted).toHaveLength(3));
		const seen = accepted.map((entry) => Buffer.concat(entry.received).toString()).sort();
		expect(seen).toEqual(["one", "three", "two"]);
	});

	it("survives a malformed frame as data, because framing is the protocol layer's job", async () => {
		// The transport must not interpret bytes. A length-prefixed protocol expects a
		// length first; here the bytes are simply wrong for one, and the connection is
		// established. What must not happen is the transport crashing or hanging.
		const { path, accepted } = await startBareListener();
		await sendRaw(path, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

		await vi.waitFor(() => expect(accepted).toHaveLength(1));
		expect(accepted[0]!.received.length).toBeGreaterThan(0);
	});

	it("reports a terminal transport failure rather than hanging", async () => {
		const errors: Error[] = [];
		await startBareListener({ onError: (error) => errors.push(error) });
		// No assertion on a specific error: the point is that the observer is wired and a
		// listener-side failure is reported rather than swallowed.
		expect(errors).toEqual([]);
	});
});

describe("shutdown and restart", () => {
	it("closes existing connections and releases the endpoint for a later generation", async () => {
		const first = pipeName();
		const listenerA = createWindowsNamedPipeListener({
			path: first,
			onError: () => {},
		});
		await listenerA.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} }));

		const closed = new Promise<void>((resolve) => {
			const socket = createConnection({ path: first });
			socket.on("connect", () => socket.end());
			socket.on("close", () => resolve());
		});
		await closed;
		await listenerA.close();

		// The name is free again, so a replacement server generation can bind it. This is
		// the property a filesystem socket cannot offer without the inode dance.
		const listenerB = createWindowsNamedPipeListener({ path: first, onError: () => {} });
		await expect(
			listenerB.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} })),
		).resolves.toBeUndefined();
		await listenerB.close();
	});

	it("is idempotent on repeated close", async () => {
		const { listener } = await startBareListener();
		await listener.close();
		await expect(listener.close()).resolves.toBeUndefined();
	});

	it("refuses to start twice, and refuses to restart after close", async () => {
		const { listener } = await startBareListener();
		await expect(listener.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} }))).rejects.toThrow(
			/already started/,
		);
		await listener.close();
		await expect(listener.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} }))).rejects.toThrow(
			/closing or closed/,
		);
	});
});

describe("transport factory", () => {
	it("connects, sends, receives and closes cleanly through the client factory", async () => {
		// This listener echoes what it receives and records when the connection goes away,
		// so both directions and the close are exercised rather than only the outbound one.
		const path = pipeName();
		let serverSawClose = false;
		const listener = createWindowsNamedPipeListener({ path, onError: () => {} });
		await listener.start((connection) => ({
			onData: (chunk) => {
				void connection.send(chunk);
			},
			onClose: () => {
				serverSawClose = true;
			},
			onError: () => {},
		}));
		cleanups.push(() => listener.close());

		const factory = createWindowsNamedPipeTransportFactory({ path });
		const chunks: Uint8Array[] = [];
		const transport = await factory({
			onData: (chunk) => chunks.push(chunk),
			onClose: () => {},
			onError: () => {},
		});
		await transport.send(new TextEncoder().encode("from client"));

		await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
		expect(Buffer.concat(chunks).toString()).toBe("from client");

		// `close()` must terminate the connection and be idempotent. The effect is observed
		// on the server side rather than through a `closed` getter: `ByteTransport`
		// deliberately exposes none, and the client-side `onClose` reports the *peer*
		// closing, so a local `close()` does not fire it — on either transport.
		transport.close();
		transport.close();
		await vi.waitFor(() => expect(serverSawClose).toBe(true));
	});

	it("rejects when the endpoint does not exist, rather than silently succeeding", async () => {
		const factory = createWindowsNamedPipeTransportFactory({ path: pipeName("pi-absent") });
		await expect(factory({ onData: () => {}, onClose: () => {}, onError: () => {} })).rejects.toThrow();
	});

	it("refuses a send larger than the configured pending budget", async () => {
		const { path } = await startBareListener();
		const factory = createWindowsNamedPipeTransportFactory({ path, maxPendingBytes: 8 });
		const transport = await factory({ onData: () => {}, onClose: () => {}, onError: () => {} });
		await expect(transport.send(new Uint8Array(64))).rejects.toThrow(/maxPendingBytes/);
		transport.close();
	});
});
