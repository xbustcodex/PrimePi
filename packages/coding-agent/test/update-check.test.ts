import { describe, expect, it } from "vitest";
import { compareVersions, describeUpdateCheck, evaluateUpdateCheck } from "../src/core/update/check.ts";

/**
 * Update checking.
 *
 * The property that defines the module: **checking is not updating.** A build
 * that silently swaps itself is a build the user did not choose, so the whole
 * policy returns a notice and there is deliberately no path here that downloads,
 * extracts or replaces anything.
 */

const released = { build: "released" as const, currentVersion: "1.2.0", channel: "stable" as const };

describe("the outcome is a notice, never an action", () => {
	it("reports a newer version and says nothing was installed", () => {
		const verdict = evaluateUpdateCheck({ ...released, latestVersion: "1.3.0" }, true);
		expect(verdict.kind).toBe("update-available");
		// The wording is part of the property: a user must not read this as an
		// install that already happened.
		if (verdict.kind !== "update-available") return;
		expect(verdict.message).toContain("Nothing has been downloaded or installed");
	});

	it("reports up to date when the channel has nothing newer", () => {
		expect(evaluateUpdateCheck({ ...released, latestVersion: "1.2.0" }, true).kind).toBe("up-to-date");
		expect(evaluateUpdateCheck({ ...released, latestVersion: "1.1.0" }, true).kind).toBe("up-to-date");
	});

	it("does nothing when checking is off", () => {
		expect(evaluateUpdateCheck({ ...released, latestVersion: "9.9.9" }, false).kind).toBe("disabled");
	});

	it("says the check failed rather than reporting a version", () => {
		// Reporting "up to date" from a check that never completed is the failure
		// this avoids.
		expect(evaluateUpdateCheck({ ...released, checkFailed: true }, true).kind).toBe("check-failed");
		expect(evaluateUpdateCheck({ ...released, latestVersion: undefined }, true).kind).toBe("check-failed");
	});
});

describe("a working build is unverifiable, not up to date", () => {
	it("reports a customized build as unverifiable", () => {
		// A modified tree is not a released build, so a diff against a release number
		// would report nothing or report noise, and neither answer would be true.
		const verdict = evaluateUpdateCheck(
			{ build: "customized", currentVersion: "0.0.0", channel: "stable", latestVersion: "1.0.0" },
			true,
		);
		expect(verdict.kind).toBe("unverifiable");
	});

	it("reports a development build as unverifiable", () => {
		expect(
			evaluateUpdateCheck(
				{ build: "development", currentVersion: "0.0.0", channel: "stable", latestVersion: "1.0.0" },
				true,
			).kind,
		).toBe("unverifiable");
	});

	it("prefers unverifiable over a failed check", () => {
		// The build kind is the more useful thing to say: it is not fixable by
		// retrying.
		expect(
			evaluateUpdateCheck({ build: "customized", currentVersion: "0", channel: "stable", checkFailed: true }, true)
				.kind,
		).toBe("unverifiable");
	});
});

describe("version comparison", () => {
	it("orders by component", () => {
		expect(compareVersions("1.2.0", "1.1.0")).toBe(1);
		expect(compareVersions("1.1.0", "1.2.0")).toBe(-1);
		expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
	});

	it("treats missing components as zero", () => {
		// Otherwise a build tagged 1.2.0 would be told it is behind 1.2.
		expect(compareVersions("1.2.0", "1.2")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
	});

	it("ignores a v prefix", () => {
		expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
	});

	it("does not read a pre-release suffix as a component", () => {
		// Reading it as one would order 1.0.0-rc1 above 1.0.0.
		expect(compareVersions("1.0.0-rc1", "1.0.0")).toBe(0);
	});
});

describe("a canary notice says what it costs", () => {
	it("names the channel and the risk", () => {
		const verdict = evaluateUpdateCheck({ ...released, channel: "canary", latestVersion: "1.3.0" }, true);
		if (verdict.kind !== "update-available") throw new Error("expected an update notice");
		expect(verdict.message).toContain("canary");
		expect(verdict.message).toContain("expected to break");
	});

	it("says the check never installs, on both channels", () => {
		// A user reading a settings hint must not wonder whether enabling it
		// changes what is installed.
		expect(describeUpdateCheck("canary")).toContain("never downloads or installs");
		expect(describeUpdateCheck("stable")).toContain("never downloads or installs");
	});
});
