import { describe, expect, it } from "vitest";
import {
	describeSourceTrust,
	isSourceAdmitted,
	reportDiscovery,
	type SkillDiscoveryOptions,
} from "../src/core/skills/discovery.ts";

/**
 * Skill and command discovery.
 *
 * The property that defines the design: **user and project sources are not
 * symmetric.** A user-level flag that is off can still be overridden by a broader
 * user setting; a project-level flag cannot, because a repository's directory is
 * under the control of whoever last committed rather than whoever runs it.
 */

const options = (overrides: Partial<SkillDiscoveryOptions> = {}): SkillDiscoveryOptions => ({
	enabled: true,
	enableNativeUser: true,
	enableNativeProject: true,
	enableClaudeUser: false,
	enableClaudeProject: true,
	enableCodexUser: false,
	enableAgentsUser: true,
	enableAgentsProject: true,
	isUserSourceEnabled: () => false,
	...overrides,
});

describe("a global off beats everything", () => {
	it("admits nothing when discovery is switched off", () => {
		// A user who disables skills should have no discovery path regardless of
		// what the individual flags say.
		const all = options({ enabled: false });
		for (const provider of ["native", "claude", "codex", "agents"] as const) {
			for (const level of ["user", "project"] as const) {
				expect(isSourceAdmitted(provider, level, all), `${provider}/${level}`).toBe(false);
			}
		}
	});
});

describe("a user source may fall back to the broader setting", () => {
	it("admits a user source whose own flag is off when the provider is broadly enabled", () => {
		// A user directory is the user's own; they control it and can read it at any
		// time, so the broader setting is allowed to admit it.
		expect(
			isSourceAdmitted("claude", "user", options({ enableClaudeUser: false, isUserSourceEnabled: () => true })),
		).toBe(true);
	});

	it("refuses when neither the flag nor the broader setting admits it", () => {
		expect(isSourceAdmitted("claude", "user", options({ isUserSourceEnabled: () => false }))).toBe(false);
	});

	it("still honours a user flag that is on", () => {
		expect(
			isSourceAdmitted("claude", "user", options({ enableClaudeUser: true, isUserSourceEnabled: () => false })),
		).toBe(true);
	});
});

describe("a project source gets no fallback", () => {
	it("is decided by its own flag alone", () => {
		// This is the asymmetry. Honouring a repository because a user-level setting
		// happened to be on is how an untrusted checkout gains the ability to run
		// code.
		expect(
			isSourceAdmitted("claude", "project", options({ enableClaudeProject: true, isUserSourceEnabled: () => true })),
		).toBe(true);
		expect(
			isSourceAdmitted(
				"claude",
				"project",
				options({ enableClaudeProject: false, isUserSourceEnabled: () => true }),
			),
		).toBe(false);
	});

	it("is refused when its flag is off, whatever the user-level setting says", () => {
		expect(
			isSourceAdmitted(
				"claude",
				"project",
				options({ enableClaudeProject: false, isUserSourceEnabled: () => true }),
			),
		).toBe(false);
	});
});

describe("a managed provider is always admitted", () => {
	it("ignores the per-provider flags", () => {
		// A managed skill is shipped by the runtime rather than discovered, so it is
		// not a trust question, and an unrelated flag must not remove it.
		const managed = options({ managedProviderId: "native", enableNativeUser: false, enableNativeProject: false });
		expect(isSourceAdmitted("native", "user", managed)).toBe(true);
		expect(isSourceAdmitted("native", "project", managed)).toBe(true);
	});

	it("does not admit anything once discovery is globally off", () => {
		const managed = options({ managedProviderId: "native", enabled: false });
		expect(isSourceAdmitted("native", "user", managed)).toBe(false);
	});

	it("leaves other providers unaffected", () => {
		const managed = options({ managedProviderId: "native", enableClaudeProject: false });
		expect(isSourceAdmitted("claude", "project", managed)).toBe(false);
	});
});

describe("the report says why a source was excluded", () => {
	it("lists admitted and excluded sources", () => {
		const report = reportDiscovery(options({ enableClaudeProject: false }));
		expect(report.excluded.some((entry) => entry.provider === "claude" && entry.level === "project")).toBe(true);
		expect(report.admitted.some((entry) => entry.provider === "claude" && entry.level === "user")).toBe(false);
	});

	it("names the global switch when discovery is off", () => {
		const report = reportDiscovery(options({ enabled: false }));
		expect(report.admitted).toHaveLength(0);
		expect(report.excluded.every((entry) => entry.reason.includes("switched off"))).toBe(true);
	});

	it("names the project exclusion specifically", () => {
		const report = reportDiscovery(options({ enableClaudeProject: false }));
		const excluded = report.excluded.find((entry) => entry.provider === "claude" && entry.level === "project");
		expect(excluded?.reason).toContain("not enabled for this project");
	});
});

describe("each level states its trust consequence", () => {
	it("says a project source runs code the repository controls", () => {
		expect(describeSourceTrust("project")).toContain("whoever last committed");
	});

	it("says a user source is the user's own", () => {
		expect(describeSourceTrust("user")).toContain("your own home directory");
	});
});
