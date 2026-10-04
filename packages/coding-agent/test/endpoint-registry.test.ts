import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerId } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverEndpoints,
	ENDPOINT_REGISTRY_VERSION,
	endpointRegistryDirectory,
	publishEndpoint,
	retractEndpoint,
} from "../src/experimental/endpoint-registry.ts";

/**
 * Adversarial coverage for the Windows discovery registry.
 *
 * The property under test throughout is that the registry is **discovery only**: an entry
 * nominates a candidate, and nothing about a file on disk can make an endpoint usable
 * without the transport's credential check. So `probe` here stands in for "connect and
 * complete the authenticated handshake" — exactly what `probeRegisteredEndpoint` does in
 * the client runtime — and every hostile case is expressed as a probe that must not be
 * reachable, or an entry that must not survive.
 */

const directories: string[] = [];
const SERVER_A = "00000000-0000-4000-8000-00000000000a" as ServerId;
const SERVER_B = "00000000-0000-4000-8000-00000000000b" as ServerId;
const DEAD_PID = 0x7fff_0000; // far above any live pid on Windows

async function scratch(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const entry = (serverId: ServerId, overrides: Record<string, unknown> = {}) => ({
	serverId,
	endpoint: `\\\\.\\pipe\\pi-${serverId}-aabbccddeeff`,
	pid: process.pid,
	createdAt: new Date().toISOString(),
	...overrides,
});

/** Always reachable. */
const up = async () => true;
/** Never reachable: a dead process, or a pipe nobody answers on. */
const down = async () => false;

describe("publishing", () => {
	it("registers one server and discovers it", async () => {
		const directory = await scratch("pi-reg-one-");
		await publishEndpoint(directory, entry(SERVER_A));

		const routes = await discoverEndpoints(directory, { probe: up });

		expect(routes.map((route) => route.serverId)).toEqual([SERVER_A]);
	});

	it("holds no credential, so a leaked registry cannot reach a server", async () => {
		const directory = await scratch("pi-reg-secret-");
		await publishEndpoint(directory, entry(SERVER_A));

		const raw = await readFile(join(endpointRegistryDirectory(directory), `${SERVER_A}.json`), "utf8");

		// The entry carries identity, endpoint, pid and a timestamp — nothing secret.
		expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
			"createdAt",
			"endpoint",
			"pid",
			"serverId",
			"version",
		]);
		expect(raw).not.toMatch(/token|secret|key|credential|bearer/i);
	});

	it("keeps two simultaneous registrations: neither loses the other", async () => {
		const directory = await scratch("pi-reg-two-");
		// Started together, as two servers in one directory would be.
		await Promise.all([publishEndpoint(directory, entry(SERVER_A)), publishEndpoint(directory, entry(SERVER_B))]);

		const routes = await discoverEndpoints(directory, { probe: up });

		expect(routes.map((route) => route.serverId)).toEqual([SERVER_A, SERVER_B]);
	});

	it("replaces only its own entry when a server restarts", async () => {
		const directory = await scratch("pi-reg-restart-");
		await publishEndpoint(directory, entry(SERVER_A, { endpoint: "\\\\.\\pipe\\pi-generation-1" }));
		await publishEndpoint(directory, entry(SERVER_B));
		// The same server identity, new generation.
		await publishEndpoint(directory, entry(SERVER_A, { endpoint: "\\\\.\\pipe\\pi-generation-2" }));

		const routes = await discoverEndpoints(directory, { probe: up });
		const a = routes.find((route) => route.serverId === SERVER_A);

		expect(routes).toHaveLength(2);
		expect(a?.endpoint).toBe("\\\\.\\pipe\\pi-generation-2");
	});

	it("writes atomically, leaving no partial file for a reader to find", async () => {
		const directory = await scratch("pi-reg-atomic-");
		await publishEndpoint(directory, entry(SERVER_A));

		const names = await readdir(endpointRegistryDirectory(directory));

		// One entry, no leftover scratch file.
		expect(names).toEqual([`${SERVER_A}.json`]);
	});
});

describe("discovery", () => {
	it("finds nothing in a directory that never held a server", async () => {
		const directory = await scratch("pi-reg-zero-");
		expect(await discoverEndpoints(directory, { probe: up })).toEqual([]);
	});

	it("returns an empty list rather than throwing for a missing directory", async () => {
		const directory = await scratch("pi-reg-missing-");
		await rm(directory, { recursive: true, force: true });
		expect(await discoverEndpoints(directory, { probe: up })).toEqual([]);
	});

	it("selects only servers that answer — an entry alone is not usable", async () => {
		const directory = await scratch("pi-reg-select-");
		await publishEndpoint(directory, entry(SERVER_A));
		await publishEndpoint(directory, entry(SERVER_B));

		// Only B answers. A is registered but unreachable, so it must not be a route.
		const routes = await discoverEndpoints(directory, {
			probe: async (candidate) => candidate.serverId === SERVER_B,
		});

		expect(routes.map((route) => route.serverId)).toEqual([SERVER_B]);
	});

	it("never selects a dead process even when its entry is fresh", async () => {
		const directory = await scratch("pi-reg-dead-");
		// A fresh entry, and the pid is alive, but nothing answers on the pipe. Liveness of the
		// *process* is not liveness of the *endpoint*, and only the handshake decides.
		await publishEndpoint(directory, entry(SERVER_A));

		expect(await discoverEndpoints(directory, { probe: down })).toEqual([]);
	});

	it("omits an entry pointing at an impostor's pipe", async () => {
		const directory = await scratch("pi-reg-fake-");
		// A hostile local process writes an entry naming its own pipe. The probe cannot
		// complete a handshake against it, so it is not a route — the registry never grants
		// access, it only nominates a candidate that then has to authenticate.
		await mkdir(endpointRegistryDirectory(directory), { recursive: true });
		await writeFile(
			join(endpointRegistryDirectory(directory), `${SERVER_A}.json`),
			JSON.stringify({
				version: ENDPOINT_REGISTRY_VERSION,
				...entry(SERVER_A, { endpoint: "\\\\.\\pipe\\attacker-owned" }),
			}),
			"utf8",
		);

		expect(await discoverEndpoints(directory, { probe: down })).toEqual([]);
	});

	it("does not use a live pid to select an entry the probe rejected", async () => {
		const directory = await scratch("pi-reg-pidreuse-");
		// PID reuse: the recorded pid is this very much alive process, but it is not the
		// server. Only the handshake can tell, so the entry must still be omitted.
		await publishEndpoint(directory, entry(SERVER_A, { pid: process.pid }));

		expect(await discoverEndpoints(directory, { probe: down })).toEqual([]);
	});

	it("leaves an entry alone when the probe throws", async () => {
		const directory = await scratch("pi-reg-throw-");
		await publishEndpoint(directory, entry(SERVER_A, { pid: DEAD_PID }));

		await discoverEndpoints(directory, {
			probe: async () => {
				throw new Error("transport exploded");
			},
		});

		// A probe that throws is not evidence of death, so the entry survives for another round.
		expect(await readdir(endpointRegistryDirectory(directory))).toEqual([`${SERVER_A}.json`]);
	});
});

describe("malformed and hostile input", () => {
	const cases: Array<[string, string]> = [
		["not json at all", "this is not json"],
		["a json array", "[]"],
		["a json scalar", '"hello"'],
		["an empty object", "{}"],
		["a wrong version", JSON.stringify({ version: 99, ...entry(SERVER_A) })],
		[
			"a non-uuid serverId",
			JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, ...entry("not-a-uuid" as ServerId) }),
		],
		["a missing endpoint", JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, serverId: SERVER_A })],
		[
			"a filesystem path instead of a pipe",
			JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, ...entry(SERVER_A, { endpoint: "/etc/passwd" }) }),
		],
		[
			"a host:port instead of a pipe",
			JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, ...entry(SERVER_A, { endpoint: "evil.example:8080" }) }),
		],
		["a non-numeric pid", JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, ...entry(SERVER_A, { pid: "1" }) })],
		[
			"an unparseable timestamp",
			JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, ...entry(SERVER_A, { createdAt: "soon" }) }),
		],
	];

	for (const [label, contents] of cases) {
		it(`ignores ${label} without throwing`, async () => {
			const directory = await scratch("pi-reg-bad-");
			await mkdir(endpointRegistryDirectory(directory), { recursive: true });
			await writeFile(join(endpointRegistryDirectory(directory), `${SERVER_A}.json`), contents, "utf8");

			await expect(discoverEndpoints(directory, { probe: up })).resolves.toEqual([]);
		});
	}

	it("ignores a truncated write — the partially-written case", async () => {
		const directory = await scratch("pi-reg-partial-");
		await mkdir(endpointRegistryDirectory(directory), { recursive: true });
		// What a crash mid-`writeFile` leaves behind. The registry tolerates it by ignoring it,
		// which is why publishing uses write-then-rename.
		const complete = JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, ...entry(SERVER_A) });
		await writeFile(
			join(endpointRegistryDirectory(directory), `${SERVER_A}.json`),
			complete.slice(0, Math.floor(complete.length / 2)),
			"utf8",
		);

		expect(await discoverEndpoints(directory, { probe: up })).toEqual([]);
	});

	it("never deletes a malformed entry it does not understand", async () => {
		const directory = await scratch("pi-reg-keep-");
		await mkdir(endpointRegistryDirectory(directory), { recursive: true });
		await writeFile(join(endpointRegistryDirectory(directory), `${SERVER_A}.json`), "corrupt", "utf8");

		await discoverEndpoints(directory, { probe: down, staleMs: 0 });

		// Destroying state we cannot parse would be worse than leaving it: it may have been
		// written by a newer version, and the next run would find nothing either way.
		expect(await readdir(endpointRegistryDirectory(directory))).toEqual([`${SERVER_A}.json`]);
	});

	it("ignores an entry whose filename disagrees with its contents", async () => {
		const directory = await scratch("pi-reg-mismatch-");
		await mkdir(endpointRegistryDirectory(directory), { recursive: true });
		// A file named for A claiming to be B must not present B under A's name.
		await writeFile(
			join(endpointRegistryDirectory(directory), `${SERVER_A}.json`),
			JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, ...entry(SERVER_B) }),
			"utf8",
		);

		expect(await discoverEndpoints(directory, { probe: up })).toEqual([]);
	});

	it("ignores an endpoint collision written as a socket-shaped name", async () => {
		const directory = await scratch("pi-reg-collide-");
		await mkdir(endpointRegistryDirectory(directory), { recursive: true });
		// A POSIX-shaped path in a Windows registry is a redacted shape, not a route.
		await writeFile(
			join(endpointRegistryDirectory(directory), `${SERVER_A}.json`),
			JSON.stringify({ version: ENDPOINT_REGISTRY_VERSION, ...entry(SERVER_A, { endpoint: "C:\\tmp\\x.sock" }) }),
			"utf8",
		);

		expect(await discoverEndpoints(directory, { probe: up })).toEqual([]);
	});
});

describe("pruning", () => {
	it("keeps a fresh entry whose probe failed, because it may be mid-restart", async () => {
		const directory = await scratch("pi-reg-grace-");
		await publishEndpoint(directory, entry(SERVER_A, { pid: DEAD_PID }));

		await discoverEndpoints(directory, { probe: down, staleMs: 60_000 });

		expect(await readdir(endpointRegistryDirectory(directory))).toEqual([`${SERVER_A}.json`]);
	});

	it("removes a stale entry only when the pid is gone too", async () => {
		const directory = await scratch("pi-reg-prune-");
		// Stale and the pid is alive (this process): a server might be between generations.
		await publishEndpoint(
			directory,
			entry(SERVER_A, { pid: process.pid, createdAt: new Date(Date.now() - 3_600_000).toISOString() }),
		);

		await discoverEndpoints(directory, { probe: down, staleMs: 1_000 });

		expect(await readdir(endpointRegistryDirectory(directory))).toEqual([`${SERVER_A}.json`]);
	});

	it("removes a stale entry with a dead pid — the crash-recovery case", async () => {
		const directory = await scratch("pi-reg-crash-");
		// What a crashed server leaves behind: old, pid gone, nothing answering.
		await publishEndpoint(
			directory,
			entry(SERVER_A, { pid: DEAD_PID, createdAt: new Date(Date.now() - 3_600_000).toISOString() }),
		);

		expect(await discoverEndpoints(directory, { probe: down, staleMs: 1_000 })).toEqual([]);
		expect(await readdir(endpointRegistryDirectory(directory))).toEqual([]);
	});

	it("survives a stale entry beside a healthy one", async () => {
		const directory = await scratch("pi-reg-mixed-");
		await publishEndpoint(
			directory,
			entry(SERVER_A, { pid: DEAD_PID, createdAt: new Date(Date.now() - 3_600_000).toISOString() }),
		);
		await publishEndpoint(directory, entry(SERVER_B));

		const routes = await discoverEndpoints(directory, {
			probe: async (candidate) => candidate.serverId === SERVER_B,
			staleMs: 1_000,
		});

		expect(routes.map((route) => route.serverId)).toEqual([SERVER_B]);
		expect(await readdir(endpointRegistryDirectory(directory))).toEqual([`${SERVER_B}.json`]);
	});
});

describe("retraction", () => {
	it("removes only its own registration", async () => {
		const directory = await scratch("pi-reg-retract-");
		await publishEndpoint(directory, entry(SERVER_A));
		await publishEndpoint(directory, entry(SERVER_B));

		await retractEndpoint(directory, SERVER_A);

		const routes = await discoverEndpoints(directory, { probe: up });
		expect(routes.map((route) => route.serverId)).toEqual([SERVER_B]);
	});

	it("is harmless when the entry is already gone", async () => {
		const directory = await scratch("pi-reg-retract-missing-");
		await publishEndpoint(directory, entry(SERVER_A));
		await retractEndpoint(directory, SERVER_A);

		await expect(retractEndpoint(directory, SERVER_A)).resolves.toBeUndefined();
	});

	it("leaves discovery working after a retraction", async () => {
		const directory = await scratch("pi-reg-restart-after-");
		await publishEndpoint(directory, entry(SERVER_A, { endpoint: "\\\\.\\pipe\\pi-gen-1" }));
		await retractEndpoint(directory, SERVER_A);
		// The next generation registers under the same identity with a new endpoint.
		await publishEndpoint(directory, entry(SERVER_A, { endpoint: "\\\\.\\pipe\\pi-gen-2" }));

		const routes = await discoverEndpoints(directory, { probe: up });
		expect(routes).toHaveLength(1);
		expect(routes[0]?.endpoint).toBe("\\\\.\\pipe\\pi-gen-2");
	});
});

describe("identity", () => {
	it("requires a canonical UUIDv4 server identity, so filenames are always Windows-safe", async () => {
		const directory = await scratch("pi-reg-identity-");
		// The parameter is typed `ServerId`, so reaching an invalid value needs the cast a
		// caller outside the type system would perform — which is exactly the case the
		// runtime guard exists for.
		const forged = "not-a-uuid" as ServerId;
		await expect(publishEndpoint(directory, entry(forged))).rejects.toThrow(/UUIDv4/);
	});

	it("uses the server identity as the filename, with no path traversal possible", async () => {
		const directory = await scratch("pi-reg-traversal-");
		const hostile = "../../escape" as ServerId;
		await expect(publishEndpoint(directory, entry(hostile))).rejects.toThrow();

		// Nothing was written outside the registry directory.
		await expect(readdir(directory)).resolves.toEqual([]);
	});

	it("derives distinct filenames for distinct identities", async () => {
		const directory = await scratch("pi-reg-distinct-");
		const ids = Array.from({ length: 4 }, () => randomUUID() as ServerId);
		await Promise.all(ids.map((id) => publishEndpoint(directory, entry(id))));

		const routes = await discoverEndpoints(directory, { probe: up });
		expect(routes.map((route) => route.serverId).sort()).toEqual([...ids].sort());
	});
});
