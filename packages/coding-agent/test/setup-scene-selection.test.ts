import { describe, expect, it } from "vitest";
import {
	CURRENT_SETUP_VERSION,
	type SetupHost,
	type SetupScene,
	selectSetupScenes,
	setupSkipEnvEnabled,
} from "../src/modes/setup/setup-scenes.ts";

/**
 * Scene selection decides whether a returning user ever sees onboarding again, so its gates are
 * tested directly rather than inferred from a launch.
 *
 * The property that matters most is the negative one: a completed install must not be asked to
 * onboard, and a user who *interrupted* onboarding must be able to finish it. Those pull in
 * opposite directions, and a presence-based gate gets both wrong - it treats an interrupted
 * user's settings file as proof of completion and strands them.
 */

function scene(id: string, minVersion: number, shouldRun?: () => boolean): SetupScene {
	return {
		id,
		title: id,
		minVersion,
		shouldRun,
		mount: () => ({ render: () => [], handleInput: () => {} }),
	};
}

const host = {
	shouldRunProbe: true,
} as unknown as SetupHost;

const tty = { isTTY: true };

describe("setup skip variable", () => {
	it.each(["1", "true", "TRUE", "yes", "on", "anything"])("treats %j as a skip", (value) => {
		expect(setupSkipEnvEnabled(value)).toBe(true);
	});

	it.each(["", "  ", "0", "false", "FALSE", "no", "NO"])("treats %j as not a skip", (value) => {
		expect(setupSkipEnvEnabled(value)).toBe(false);
	});

	it("treats unset as not a skip, so onboarding is on by default", () => {
		expect(setupSkipEnvEnabled(undefined)).toBe(false);
	});
});

describe("scene selection", () => {
	const scenes = [scene("a", 1), scene("b", 1), scene("c", 2)];

	it("runs every scene for a version that has never onboarded", async () => {
		const selected = await selectSetupScenes(0, scenes, host, { ...tty });
		expect(selected.map((s) => s.id)).toEqual(["a", "b", "c"]);
	});

	it("skips scenes already completed, and only those", async () => {
		// The case a boolean "setupDone" flag cannot express: a release adds a scene, and the
		// user who finished the earlier version should be shown exactly the new work.
		const selected = await selectSetupScenes(1, scenes, host, { ...tty });
		expect(selected.map((s) => s.id)).toEqual(["c"]);
	});

	it("selects nothing once the stored version is current", async () => {
		expect(await selectSetupScenes(CURRENT_SETUP_VERSION, scenes, host, { ...tty })).toEqual([]);
	});

	it("preserves declared scene order", async () => {
		const selected = await selectSetupScenes(0, [scene("z", 1), scene("a", 1)], host, { ...tty });
		expect(selected.map((s) => s.id)).toEqual(["z", "a"]);
	});

	it("skips a scene whose shouldRun reports it does not apply", async () => {
		const gated = [scene("a", 1, () => false), scene("b", 1, () => true)];
		const selected = await selectSetupScenes(0, gated, host, { ...tty });
		expect(selected.map((s) => s.id)).toEqual(["b"]);
	});

	it("omits a scene with shouldRun when no host is available", async () => {
		// Better to skip than to run a scene whose applicability cannot be checked.
		const gated = [scene("a", 1, () => true), scene("b", 1)];
		const selected = await selectSetupScenes(0, gated, undefined, { ...tty });
		expect(selected.map((s) => s.id)).toEqual(["b"]);
	});

	it("returns nothing for a non-TTY launch even when forced", async () => {
		// There is no keyboard, so an interactive prompt would hang the process forever.
		expect(await selectSetupScenes(0, scenes, host, { isTTY: false, force: true })).toEqual([]);
	});

	it("returns nothing while resuming a session", async () => {
		expect(await selectSetupScenes(0, scenes, host, { ...tty, resuming: true })).toEqual([]);
	});

	it("returns nothing when the settings opt-out is off", async () => {
		expect(await selectSetupScenes(0, scenes, host, { ...tty, setupWizardEnabled: false })).toEqual([]);
	});

	it("honours PI_SKIP_SETUP", async () => {
		const original = process.env.PI_SKIP_SETUP;
		try {
			process.env.PI_SKIP_SETUP = "1";
			expect(await selectSetupScenes(0, scenes, host, { ...tty })).toEqual([]);
		} finally {
			if (original === undefined) delete process.env.PI_SKIP_SETUP;
			else process.env.PI_SKIP_SETUP = original;
		}
	});

	it("still runs when forced, bypassing the version gate", async () => {
		process.env.PI_SKIP_SETUP = "1";
		try {
			const selected = await selectSetupScenes(CURRENT_SETUP_VERSION, scenes, host, { ...tty, force: true });
			expect(selected.map((s) => s.id)).toEqual(["a", "b", "c"]);
		} finally {
			delete process.env.PI_SKIP_SETUP;
		}
	});
});
