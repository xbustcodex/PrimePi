import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Auto-resume wiring.
 *
 * `autoResume` was registered, marked live-verified, and read by nothing. This
 * test is deliberately structural rather than behavioural: the code under test is
 * the *startup* path, which requires a real session directory, a real previous
 * session and a process, none of which a unit test can provide honestly.
 *
 * So what is asserted here is that the decision exists in the startup path at all,
 * that it is gated on the setting, and — the part that is easy to get wrong — that
 * it marks the resume so the model's settings are restored too.
 *
 * A test that could not be written because the behaviour is unreachable is itself
 * evidence of the defect. This one could be written, and it is narrow about what
 * it claims.
 */

/**
 * The repository root, resolved from this file.
 *
 * `process.cwd()` is the repo root when this file is invoked directly and the package
 * directory under the suite runner, so a path built from it resolves to
 * `<package>/packages/coding-agent/src/main.ts` - which does not exist - and the test
 * fails in one invocation and passes in the other.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const mainSource = (): string => readFileSync(path.join(REPO_ROOT, "packages/coding-agent/src/main.ts"), "utf8");

describe("auto-resume is wired into startup", () => {
	it("reads the setting in the session-creation path", () => {
		// Without this the flag is a UI control that changes nothing, which is the
		// archetype this audit found 18 of.
		expect(mainSource()).toMatch(/getSetting\("autoResume"\)/);
	});

	it("is gated on the setting being true", () => {
		expect(mainSource()).toMatch(/getSetting\("autoResume"\)\?\.value === true/);
	});

	it("continues the most recent session rather than creating a new one", () => {
		expect(mainSource()).toMatch(/autoResume[\s\S]{0,400}SessionManager\.continueRecent/);
	});

	it("marks the resume so the model and thinking level are restored", () => {
		// The subtle part: resuming the transcript but resetting the model silently
		// changes which model answers it. Marking `parsed.continue` is what makes
		// buildSessionOptions take the session's own values.
		expect(mainSource()).toMatch(/autoResume[\s\S]{0,600}parsed\.continue = true/);
	});

	it("only resumes when a prior session actually has entries", () => {
		// An empty session file would otherwise be resumed as if it had history.
		expect(mainSource()).toMatch(/getEntries\(\)\.length > 0/);
	});
});

describe("the resume path is ordered after the explicit flags", () => {
	it("an explicit --continue is not second-guessed", () => {
		const source = mainSource();
		const explicit = source.indexOf("if (parsed.continue) {");
		const automatic = source.indexOf('getSetting("autoResume")');
		// The automatic path must come after, or it would resume a session the user
		// asked to bypass.
		expect(explicit).toBeGreaterThan(-1);
		expect(automatic).toBeGreaterThan(explicit);
	});
});
