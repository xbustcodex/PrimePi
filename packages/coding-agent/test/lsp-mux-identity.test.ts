import { describe, expect, it } from "vitest";
import {
	acquireServer,
	isRedactedKey,
	isSharedKeyInUse,
	muxServerKey,
} from "../src/core/lsp/mux-identity.ts";

/**
 * Language-server identity for a shared mux.
 *
 * The property that makes sharing sound: **the identity includes everything that
 * changes behaviour.** Keyed on command and cwd alone, an idle server started
 * with one argument set would be handed to a link that asked for another.
 */

const base = { command: "typescript-language-server", args: ["--stdio"], cwd: "/repo" };

describe("identity covers everything that changes behaviour", () => {
	it("is stable for the same configuration", () => {
		expect(muxServerKey(base)).toBe(muxServerKey({ ...base }));
	});

	it("differs when the command differs", () => {
		expect(muxServerKey(base)).not.toBe(muxServerKey({ ...base, command: "pyright-langserver" }));
	});

	it("differs when an argument differs", () => {
		// The case that motivated the whole identity: two links agreeing on command
		// and cwd but differing in args are not interchangeable.
		expect(muxServerKey(base)).not.toBe(muxServerKey({ ...base, args: ["--stdio", "--log-level", "4"] }));
	});

	it("differs when the working directory differs", () => {
		expect(muxServerKey(base)).not.toBe(muxServerKey({ ...base, cwd: "/other" }));
	});

	it("differs when an environment value differs", () => {
		expect(muxServerKey({ ...base, env: { LOG: "debug" } })).not.toBe(
			muxServerKey({ ...base, env: { LOG: "info" } }),
		);
	});

	it("treats omitted args as empty rather than distinct", () => {
		// A link that omits args and one that passes an empty list describe the same
		// server, so they must not start a second one.
		const bare = { command: base.command, cwd: base.cwd };
		expect(muxServerKey(bare)).toBe(muxServerKey({ ...bare, args: [] }));
		// And a link that *does* pass args is a different server.
		expect(muxServerKey(bare)).not.toBe(muxServerKey(base));
	});
});

describe("two details that are load-bearing", () => {
	it("sorts env keys so insertion order never splits one identity", () => {
		// A process environment's enumeration order is not meaningful, and two links
		// built the same way can enumerate it differently.
		const a = { ...base, env: { LOG: "debug", PATH: "/bin", TZ: "utc" } };
		const b = { ...base, env: { TZ: "utc", PATH: "/bin", LOG: "debug" } };
		expect(muxServerKey(a)).toBe(muxServerKey(b));
	});

	it("cannot have a separator forged from an argument", () => {
		// Without encoding, these would join to the same string.
		const split = muxServerKey({ ...base, args: ["--log-level", "4"] });
		const joined = muxServerKey({ ...base, args: ["--log-level 4"] });
		expect(split).not.toBe(joined);
	});

	it("cannot have a separator forged from a path", () => {
		expect(muxServerKey({ ...base, cwd: "/a/b" })).not.toBe(muxServerKey({ ...base, args: ["/a"], cwd: "/b" }));
	});
});

describe("the key never carries a credential", () => {
	it("is hashed, not readable", () => {
		// The key travels over the handshake and into mux logs, and a raw
		// environment holds ANTHROPIC_API_KEY and the rest.
		const key = muxServerKey({ ...base, env: { ANTHROPIC_API_KEY: "sk-ant-secret" } });
		expect(key).not.toContain("sk-ant-secret");
		expect(key).not.toContain("ANTHROPIC_API_KEY");
		expect(key.startsWith("sha256:")).toBe(true);
	});

	it("reports itself as redacted, so a caller never has to ask", () => {
		expect(isRedactedKey(muxServerKey(base))).toBe(true);
		expect(isRedactedKey("tsls:/stdio")).toBe(false);
	});
});

describe("sharing degrades rather than fails", () => {
	it("uses a shared server when the broker is up", () => {
		const result = acquireServer({ params: base, shared: true, brokerAvailable: true });
		expect(result.acquisition).toBe("shared");
	});

	it("reuses an existing shared server for the same identity", () => {
		const key = muxServerKey(base);
		const result = acquireServer({ params: base, shared: true, brokerAvailable: true, existingShared: true });
		expect(result.reason).toContain("reusing");
		expect(result.key).toBe(key);
	});

	it("falls back to a private server when the broker is unreachable", () => {
		// A user with no daemon still gets working language intelligence, just the
		// slower kind - never an error they cannot act on.
		const result = acquireServer({ params: base, shared: true, brokerAvailable: false });
		expect(result.acquisition).toBe("private");
		expect(result.reason).toContain("unreachable");
	});

	it("uses a private server when sharing is switched off", () => {
		const result = acquireServer({ params: base, shared: false, brokerAvailable: true });
		expect(result.acquisition).toBe("private");
		expect(result.reason).toContain("switched off");
	});

	it("computes the key either way, so a fallback is still addressable", () => {
		const shared = acquireServer({ params: base, shared: true, brokerAvailable: true });
		const private_ = acquireServer({ params: base, shared: true, brokerAvailable: false });
		expect(private_.key).toBe(shared.key);
	});
});

describe("deciding whether a server is already up", () => {
	it("finds a key in use", () => {
		const key = muxServerKey(base);
		expect(isSharedKeyInUse([key], key)).toBe(true);
	});

	it("does not find an absent key", () => {
		expect(isSharedKeyInUse([muxServerKey({ ...base, cwd: "/other" })], muxServerKey(base))).toBe(false);
	});

	it("handles an empty registry", () => {
		expect(isSharedKeyInUse([], muxServerKey(base))).toBe(false);
	});
});
