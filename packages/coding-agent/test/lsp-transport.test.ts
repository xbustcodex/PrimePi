import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAX_BUFFER_BYTES,
	DEFAULT_MAX_MESSAGE_BYTES,
	LspTransport,
	MessageFramer,
	TestTransport,
} from "../src/core/lsp/transport.ts";

/**
 * Adversarial tests for the LSP transport.
 *
 * A language server is an untrusted external process. These tests treat it as
 * one: they feed the framer fragments, garbage, absurd lengths and hostile
 * content, and they check that the transport either routes a real message or
 * refuses — never that it wedges, leaks, or resolves a request with the wrong
 * answer.
 */

function framed(body: unknown): Buffer {
	const text = JSON.stringify(body);
	const length = Buffer.byteLength(text, "utf8");
	return Buffer.from(`Content-Length: ${length}\r\n\r\n${text}`, "utf8");
}

describe("message framing", () => {
	it("decodes one whole message", () => {
		const framer = new MessageFramer();
		framer.push(framed({ jsonrpc: "2.0", id: 1, result: "ok" }));
		expect(framer.drain()).toEqual(['{"jsonrpc":"2.0","id":1,"result":"ok"}']);
	});

	it("reassembles a frame split across arbitrary chunk boundaries", () => {
		// The classic LSP bug: splitting on chunk boundaries loses the tail and
		// the client waits forever for a message that already arrived.
		const bytes = framed({ jsonrpc: "2.0", id: 7, result: { deep: [1, 2, 3] } });
		for (let size = 1; size <= bytes.length; size++) {
			const framer = new MessageFramer();
			framer.push(bytes.subarray(0, size));
			const first = framer.drain();
			framer.push(bytes.subarray(size));
			const second = framer.drain();
			expect([...first, ...second], `split at ${size}`).toHaveLength(1);
		}
	});

	it("yields every message in a single chunk", () => {
		// Reading one message per chunk leaves the rest buffered until the next
		// one arrives, which presents as a server that went quiet.
		const framer = new MessageFramer();
		framer.push(
			Buffer.concat([
				framed({ jsonrpc: "2.0", id: 1, result: "a" }),
				framed({ jsonrpc: "2.0", id: 2, result: "b" }),
				framed({ jsonrpc: "2.0", method: "note", params: {} }),
			]),
		);
		expect(framer.drain()).toHaveLength(3);
	});

	it("uses byte length, not character length, for non-ASCII content", () => {
		// A string's length is smaller than its byte length, so slicing by
		// characters desynchronises the stream permanently.
		const payload = { jsonrpc: "2.0", id: 1, result: "日本語のテキストと絵文字🎉" };
		const bytes = framed(payload);
		const framer = new MessageFramer();
		// Delivered one byte at a time: only a byte-correct framer survives.
		for (const byte of bytes) framer.push(Buffer.from([byte]));
		const drained = framer.drain();
		expect(drained).toHaveLength(1);
		expect(JSON.parse(drained[0])).toEqual(payload);
	});

	it("accepts a lowercase header name, as the spec requires", () => {
		const framer = new MessageFramer();
		framer.push(Buffer.from('content-length: 11\r\n\r\n{"jsonrpc"}', "utf8"));
		expect(framer.drain()).toEqual(['{"jsonrpc"}']);
	});

	it("resyncs past a header block with no Content-Length", () => {
		// A wrapper script printing to stdout produces this. Stalling on the same
		// junk header forever looks like a live server that answers nothing.
		const framer = new MessageFramer();
		const resynced: string[] = [];
		framer.push(Buffer.from("starting server...\r\n\r\n", "utf8"));
		framer.push(framed({ jsonrpc: "2.0", id: 1, result: "after" }));
		const messages = framer.drain((header) => resynced.push(header));
		expect(resynced).toHaveLength(1);
		expect(messages).toEqual(['{"jsonrpc":"2.0","id":1,"result":"after"}']);
	});

	it("refuses an absurd Content-Length instead of allocating it", () => {
		// Honouring this would be the denial of service.
		const framer = new MessageFramer(undefined, { maxMessageBytes: 1024 });
		framer.push(Buffer.from(`Content-Length: ${DEFAULT_MAX_MESSAGE_BYTES * 4}\r\n\r\n`, "utf8"));
		expect(framer.drain()).toEqual([]);
		// And it recovers: a later well-framed message still parses.
		framer.push(framed({ jsonrpc: "2.0", id: 2, result: "ok" }));
		expect(framer.drain()).toHaveLength(1);
	});

	it("caps the buffer so a stream of garbage cannot grow without bound", () => {
		// The default cap, asserted directly: a partial header that never completes
		// must not be allowed to hold unbounded memory.
		const framer = new MessageFramer();
		framer.push(Buffer.from("x".repeat(DEFAULT_MAX_BUFFER_BYTES + 1024), "utf8"));
		framer.drain();
		expect(framer.buffered).toBeLessThanOrEqual(DEFAULT_MAX_BUFFER_BYTES);
	});

	it("accepts a bare-LF header separator", () => {
		// A non-conforming server emitting only \n is common enough that refusing it
		// would break a real setup for no safety gain.
		const framer = new MessageFramer();
		framer.push(Buffer.from('Content-Length: 11\n\n{"jsonrpc"}', "utf8"));
		expect(framer.drain()).toEqual(['{"jsonrpc"}']);
	});
});

describe("request correlation", () => {
	it("routes a response to the request that is waiting", async () => {
		const transport = new TestTransport("t");
		const first = transport.request<string>("a/one", {});
		const second = transport.request<string>("a/two", {});
		// Answered out of order, which is legal and which a FIFO queue would break.
		transport.deliverFramed({ jsonrpc: "2.0", id: 2, result: "second" });
		transport.deliverFramed({ jsonrpc: "2.0", id: 1, result: "first" });
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
	});

	it("treats a message with a method as server-originated even when its id collides", async () => {
		// The bug OMP hit in production (#3001): a `workspace/configuration` pull
		// arrives with an id that collides with an in-flight request. Matching
		// pending requests first would swallow the pull, drop the answer the
		// server is blocked on, and resolve our own request with undefined.
		const pulls: string[] = [];
		const transport = new TestTransport("t", {
			onServerRequest: (method) => {
				pulls.push(method);
				return { answer: true };
			},
		});
		const pending = transport.request<string>("textDocument/documentSymbol", {});
		// Same id as our in-flight request, but it carries a method.
		transport.deliverFramed({ jsonrpc: "2.0", id: 1, method: "workspace/configuration", params: { items: [] } });
		await Promise.resolve();
		expect(pulls).toEqual(["workspace/configuration"]);
		// Our request is still pending, not resolved with the server's payload.
		expect(transport.pendingCount).toBe(1);
		transport.deliverFramed({ jsonrpc: "2.0", id: 1, result: { name: "symbol" } });
		await expect(pending).resolves.toEqual({ name: "symbol" });
	});

	it("rejects a request that came back with an error", async () => {
		const transport = new TestTransport("t");
		const pending = transport.request("a/method", {});
		transport.deliverFramed({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32601, message: "no such method" },
		});
		await expect(pending).rejects.toThrow(/no such method/);
	});

	it("ignores a response for an id it never issued", () => {
		const transport = new TestTransport("t");
		// A server answering a request we did not make, or a duplicate response,
		// must not disturb anything.
		expect(() => transport.deliverFramed({ jsonrpc: "2.0", id: 999, result: "stray" })).not.toThrow();
		expect(transport.pendingCount).toBe(0);
	});

	it("keeps the reader alive through a malformed message", async () => {
		const transport = new TestTransport("t");
		const pending = transport.request<string>("a/method", {});
		// Well-framed, valid JSON, but not an object.
		transport.deliverFramed([1, 2, 3]);
		// And a well-framed body that is not JSON at all.
		transport.deliverRaw(Buffer.from("Content-Length: 5\r\n\r\n{not ", "utf8"));
		transport.deliverFramed({ jsonrpc: "2.0", id: 1, result: "still here" });
		await expect(pending).resolves.toBe("still here");
	});

	it("routes a notification to the handler", () => {
		const seen: string[] = [];
		const transport = new TestTransport("t", { onNotification: (method) => seen.push(method) });
		transport.deliverFramed({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {} });
		expect(seen).toEqual(["textDocument/publishDiagnostics"]);
	});

	it("declines a server request when no handler is installed", () => {
		// Declining beats silence: a server blocked on an unanswered request stalls
		// its own handshake.
		const transport = new TestTransport("t");
		transport.deliverFramed({ jsonrpc: "2.0", id: 5, method: "workspace/applyEdit", params: {} });
		const response = transport.sent.at(-1) as { id: number; error?: { code: number } };
		expect(response.id).toBe(5);
		expect(response.error?.code).toBe(-32601);
	});

	it("answers a server request without letting a throw kill the reader", async () => {
		const transport = new TestTransport("t", {
			onServerRequest: (method) => {
				if (method === "boom") throw new Error("handler exploded");
				return "fine";
			},
		});
		transport.deliverFramed({ jsonrpc: "2.0", id: 1, method: "boom" });
		// The response is written after the handler settles, which is a later turn
		// of the microtask queue. Draining it explicitly makes this deterministic
		// rather than a race against the event loop.
		await new Promise((resolve) => setImmediate(resolve));
		const failed = transport.sent.at(-1) as { error?: { message: string } };
		expect(failed.error?.message).toBe("handler exploded");
		// Later messages still route: the reader survived the throw. The id is
		// read from what the transport actually sent, because a server request
		// does not consume the client's id counter.
		const pending = transport.request<string>("a/method", {});
		const issued = (transport.sent.at(-1) as { id?: number }).id ?? 1;
		transport.deliverFramed({ jsonrpc: "2.0", id: issued, result: "after" });
		await expect(pending).resolves.toBe("after");
	});
});

describe("cancellation, timeout and process death", () => {
	it("rejects a timed-out request and forgets it", async () => {
		vi.useFakeTimers();
		try {
			const transport = new TestTransport("t");
			const pending = transport.request("slow", {}, { timeoutMs: 50 });
			const assertion = expect(pending).rejects.toThrow(/timed out/);
			await vi.advanceTimersByTimeAsync(60);
			await assertion;
			expect(transport.pendingCount).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects an aborted request", async () => {
		const controller = new AbortController();
		const transport = new TestTransport("t");
		const pending = transport.request("slow", {}, { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		expect(transport.pendingCount).toBe(0);
	});

	it("rejects immediately for an already-aborted signal", async () => {
		const transport = new TestTransport("t");
		await expect(transport.request("x", {}, { signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
	});

	it("fails every in-flight request when the transport closes", async () => {
		// A server that dies must not leave callers hanging: an unresolved
		// promise is a leaked future and a session waiting on it waits forever.
		const transport = new TestTransport("t");
		const first = transport.request("a/one", {});
		const second = transport.request("a/two", {});
		transport.close("server exited");
		await expect(first).rejects.toThrow(/server exited/);
		await expect(second).rejects.toThrow(/server exited/);
		expect(transport.pendingCount).toBe(0);
		expect(transport.closed).toBe(true);
	});

	it("refuses new requests once closed", async () => {
		const transport = new TestTransport("t");
		transport.close("gone");
		await expect(transport.request("x", {})).rejects.toThrow(/closed/);
	});

	it("is idempotent on close and reports the reason once", () => {
		const reasons: string[] = [];
		const transport = new TestTransport("t", { onClose: (reason) => reasons.push(reason) });
		transport.close("first");
		transport.close("second");
		expect(reasons).toEqual(["first"]);
	});

	it("ignores bytes received after close", () => {
		const transport = new TestTransport("t");
		transport.close("done");
		expect(() => transport.deliverFramed({ jsonrpc: "2.0", id: 1, result: "x" })).not.toThrow();
	});
});

describe("lifecycle is a transport concern, not a session concern", () => {
	it("carries a stable name for diagnostics", () => {
		expect(new TestTransport("typescript-language-server").name).toBe("typescript-language-server");
	});

	it("exposes in-flight count so a caller can drain before shutdown", async () => {
		const transport = new TestTransport("t");
		transport.request("a/one", {});
		transport.request("a/two", {});
		expect(transport.pendingCount).toBe(2);
		transport.close("shutdown");
		expect(transport.pendingCount).toBe(0);
	});

	it("is a base class whose base contract is sufficient for an in-memory server", () => {
		// The abstraction exists so a test needs no child process; that is only true
		// if LspTransport itself carries request/notify/receive.
		const transport = new LspTransport("bare");
		expect(typeof transport.request).toBe("function");
		expect(typeof transport.notify).toBe("function");
		expect(typeof transport.receive).toBe("function");
	});
});
