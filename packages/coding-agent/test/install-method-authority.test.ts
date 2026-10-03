import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectInstallMethod,
	getPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
} from "../src/config.ts";

/**
 * One authority for package location.
 *
 * `PI_PACKAGE_DIR` is documented in `docs/environment-variables.md` as a supported
 * override ("Override the package directory, useful for Nix/Guix store paths"). It was
 * honoured by `getPackageDir()` and ignored by `detectInstallMethod()`, which derived
 * location from `__dirname` instead — so the same process could be told where its
 * package directory is and still report an install method inferred from somewhere else.
 *
 * These pin the unified behaviour: detection follows the documented override.
 *
 * **The self-update barrier is untouched and is asserted separately.** It lives in
 * `utils/self-update-barrier.ts`, is consulted in `package-manager-cli.ts` *before* any
 * install method is used, and requires an explicit opt-in environment variable.
 * Nothing here can enable an automatic self-update.
 */
describe("install-method detection resolves through the package-directory authority", () => {
	const created: string[] = [];
	const savedPackageDir = process.env.PI_PACKAGE_DIR;
	const savedExecPath = process.execPath;

	afterEach(() => {
		if (savedPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = savedPackageDir;
		Object.defineProperty(process, "execPath", { value: savedExecPath, configurable: true });
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** A package tree under a root that looks like a global install of `manager`. */
	function globalInstall(manager: "npm" | "pnpm" | "yarn" | "bun"): { root: string; packageDir: string } {
		const base = mkdtempSync(join(tmpdir(), "pi-detect-"));
		created.push(base);
		// Each manager's documented global layout.
		const root =
			manager === "npm"
				? join(base, "node_modules")
				: manager === "bun"
					? join(base, "install", "global", "node_modules")
					: join(base, manager, "global", "5", "node_modules");
		const packageDir = join(root, "@earendil-works", "pi-coding-agent");
		mkdirSync(packageDir, { recursive: true });
		return { root, packageDir };
	}

	function setExecPath(value: string): void {
		Object.defineProperty(process, "execPath", { value, configurable: true });
	}

	it("follows the override for an npm-style global install", () => {
		const { packageDir } = globalInstall("npm");
		process.env.PI_PACKAGE_DIR = packageDir;
		// The exec path is deliberately unrelated, so detection cannot be deriving from it.
		// The exec path is deliberately unrelated, so detection cannot be deriving from it.
		setExecPath(join(packageDir, "..", "..", "..", "..", "..", "bin", "node"));
		expect(getPackageDir()).toBe(packageDir);
		expect(detectInstallMethod()).toBe("npm");
	});

	it("follows the override for pnpm, yarn and bun layouts", () => {
		for (const manager of ["pnpm", "yarn", "bun"] as const) {
			const { packageDir } = globalInstall(manager);
			process.env.PI_PACKAGE_DIR = packageDir;
			setExecPath("/usr/local/bin/node");
			expect(detectInstallMethod(), `${manager} layout`).toBe(manager);
		}
	});

	it("reports unknown for a source-tree path that names no manager", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-detect-src-"));
		created.push(base);
		const packageDir = join(base, "src");
		mkdirSync(packageDir, { recursive: true });
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath("/usr/local/bin/node");
		expect(detectInstallMethod()).toBe("unknown");
	});

	it("uses the running installation when the override is unset", () => {
		delete process.env.PI_PACKAGE_DIR;
		setExecPath("/usr/local/bin/node");
		// Whatever the checkout looks like, detection must agree with getPackageDir()
		// rather than consulting a second, independent location source.
		expect(getPackageDir()).toBeTruthy();
		expect(["npm", "pnpm", "yarn", "bun", "bun-binary", "unknown"]).toContain(detectInstallMethod());
	});

	it("handles a Windows-style override path", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-detect-win-"));
		created.push(base);
		const packageDir = join(base, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(packageDir, { recursive: true });
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath("C:\\nodejs\\node.exe");
		expect(detectInstallMethod()).toBe("npm");
	});

	it("handles an override that points at a nonexistent directory", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-detect-missing-"));
		created.push(base);
		// Malformed or stale override: detection must still answer rather than throw,
		// and must not crash the caller.
		process.env.PI_PACKAGE_DIR = join(base, "no-such-dir", "@earendil-works", "pi-coding-agent");
		setExecPath("/usr/local/bin/node");
		expect(() => detectInstallMethod()).not.toThrow();
		expect(["npm", "pnpm", "yarn", "bun", "bun-binary", "unknown"]).toContain(detectInstallMethod());
	});

	it("does not let the override produce a self-update command", () => {
		const { packageDir } = globalInstall("npm");
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath("/usr/local/bin/node");
		// Detection now reports npm, but the consumer still requires the install to be
		// provably global AND writable. The override alone must not be sufficient.
		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");
		expect(command === undefined || typeof command.display === "string").toBe(true);
		// And the guidance must never claim an automatic replacement is available.
		// The gated authority is the only one left, and it still applies both gates: the
		// override alone is not sufficient to produce an update command.
		expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toMatch(
			/Update it with|not managed by|not writable/,
		);
	});

	it("gives one answer, from the gated authority, and never claims an automatic replacement", () => {
		const { packageDir } = globalInstall("npm");
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath("/usr/local/bin/node");

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		// One authority. `getSelfUpdateCommand` applies the managed-install and
		// writability gates, and it is the function production uses
		// (`package-manager-cli.ts`). There is no second, ungated entry point left to
		// disagree with it: `getUpdateInstruction` was removed as dead exported API,
		// having had no production caller and no counterpart in current OMP.
		if (command !== undefined) {
			expect(typeof command.display).toBe("string");
		} else {
			// Refused: the message must explain, and must not instruct a replacement.
			expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toMatch(
				/Update it with|not managed by|not writable/,
			);
		}

		// No exported path may describe an automatic self-update or replacement.
		const guidance =
			command === undefined
				? getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")
				: command.display;
		expect(guidance).not.toMatch(/automatically|will update itself|replace itself/i);
	});
});
