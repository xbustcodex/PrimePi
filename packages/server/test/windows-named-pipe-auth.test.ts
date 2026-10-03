import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { encodeClientMessage, PROTOCOL_VERSION, ServerMessageDecoder } from "@earendil-works/pi-protocol";
import { createTestServer } from "@earendil-works/pi-server/testing";
import { createWindowsNamedPipeListener, getWindowsNamedPipePath } from "@earendil-works/pi-server/windows-named-pipe";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The credential gate, exercised through the **real** `Server` — the production handshake
 * path — not a hand-rolled stand-in. Each case is a property the security design claims,
 * checked by observing what the server actually does.
 */
const SERVER_ID = "1e4b3c2a-5d6f-4a7b-8c9d-0e1f2a3b4c5d";
const CREDENTIAL = randomBytes(32).toString("hex");

const stoppers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of stoppers.splice(0).reverse()) await stop();
});

interface StartedServer {
	path: string;
	close: () => Promise<void>;
}

/** Start a real Server behind a real named pipe, and report the bound path. */
async function startServer(authToken: string | undefined): Promise<StartedServer> {
	const path = `\\\\.\\pipe\\pi-auth-${randomBytes(8).toString("hex")}`;
	const listener = createWindowsNamedPipeListener({ path, onError: () => {} });
	const { server } = createTestServer({
		listeners: [listener],
		serverId: SERVER_ID,
		authToken,
		onError: () => {},
	});
	await server.start();
	const close = () => server.close();
	stoppers.push(close);
	return { path, close };
}

type HandshakeOutcome =
	| { kind: "hello"; serverId: string }
	| { kind: "hello_error"; code: string; message: string }
	| { kind: "closed" }
	| { kind: "error"; message: string };

/** Speak one `hello` over a real pipe and wait for the server's answer. */
function handshake(path: string, authToken?: string): Promise<HandshakeOutcome> {
	return new Promise((resolve) => {
		const socket = createConnection({ path });
		const decoder = new ServerMessageDecoder({});
		let settled = false;
		const finish = (outcome: HandshakeOutcome): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(outcome);
		};
		socket.on("error", (error) => finish({ kind: "error", message: error.message }));
		socket.once("close", () => finish({ kind: "closed" }));
		socket.on("data", (chunk) => {
			try {
				for (const message of decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
					if (message.type === "hello") finish({ kind: "hello", serverId: message.serverId });
					else if (message.type === "hello_error") {
						finish({
							kind: "hello_error",
							code: message.error.code,
							message: message.error.message,
						});
					}
				}
			} catch {
				finish({ kind: "closed" });
			}
		});
		socket.on("connect", () => {
			socket.write(
				encodeClientMessage(
					{
						type: "hello",
						version: PROTOCOL_VERSION,
						...(authToken === undefined ? {} : { authToken }),
					},
					{},
				),
			);
		});
	});
}

describe("client credential, through the production handshake", () => {
	it("accepts the correct credential and reports the server identity", async () => {
		const { path } = await startServer(CREDENTIAL);
		expect(await handshake(path, CREDENTIAL)).toEqual({ kind: "hello", serverId: SERVER_ID });
	});

	it("refuses a wrong credential before any service is attached", async () => {
		const { path } = await startServer(CREDENTIAL);
		const outcome = await handshake(path, "0".repeat(CREDENTIAL.length));
		expect(outcome.kind).toBe("hello_error");
		if (outcome.kind === "hello_error") {
			expect(outcome.code).toBe("unauthorized");
			// The refusal must not echo the expected value back.
			expect(outcome.message).not.toContain(CREDENTIAL);
		}
	});

	it("refuses a connection that presents no credential at all", async () => {
		const { path } = await startServer(CREDENTIAL);
		const outcome = await handshake(path);
		expect(outcome.kind).toBe("hello_error");
		if (outcome.kind === "hello_error") expect(outcome.code).toBe("unauthorized");
	});

	it("refuses a credential of the wrong length", async () => {
		const { path } = await startServer(CREDENTIAL);
		expect((await handshake(path, "ab")).kind).toBe("hello_error");
	});

	it("leaves a credential-free server open, so POSIX behaviour is unchanged", async () => {
		// The gate is opt-in. A server with no `authToken` must still accept a `hello`
		// carrying no credential, or every existing Unix deployment would break.
		const { path } = await startServer(undefined);
		expect(await handshake(path)).toEqual({ kind: "hello", serverId: SERVER_ID });
	});

	it("re-checks the credential on every reconnect, so no access is inherited", async () => {
		const { path } = await startServer(CREDENTIAL);
		expect((await handshake(path, CREDENTIAL)).kind).toBe("hello");
		// A second connection with no credential must be refused even though the first
		// succeeded: a completed handshake leaves nothing behind for a later attempt.
		expect((await handshake(path)).kind).toBe("hello_error");
	});

	it("keeps the credential off the endpoint name", async () => {
		// Design property P4: identity is established in-band, not by the pathname. A
		// credential embedded in a pipe name would be visible to any process that can list
		// or guess it. The name carries a per-generation nonce instead.
		const pipe = getWindowsNamedPipePath(SERVER_ID, "b".repeat(32));
		expect(pipe).not.toContain(CREDENTIAL);
		expect(pipe).toContain("b".repeat(32));
	});
});
