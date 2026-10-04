import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { spawnProcessSync } from "./utils/child-process.ts";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

/** Detect the esbuild-bundled Node.js distribution. */
declare const PI_BUNDLED_NODE: boolean;
export const isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

export type SelfUpdatePackageTarget = string | { packageName: string; installSpec?: string };

function normalizeSelfUpdatePackageTarget(target: SelfUpdatePackageTarget): {
	packageName: string;
	installSpec: string;
} {
	if (typeof target === "string") {
		return { packageName: target, installSpec: target };
	}
	return { packageName: target.packageName, installSpec: target.installSpec ?? target.packageName };
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

/**
 * The same command, with `--prefix <prefix>` supplied when the layout declares one.
 *
 * The refusal names a prefix; the command it suggests has to use it, or the advice does not
 * work for the directory pi just told the user about. Used only in messages — it never
 * gates anything.
 */
function npmCommandWithPrefix(command: SelfUpdateCommand, prefix: string): SelfUpdateCommand {
	if (command.args.includes("--prefix")) return command;
	const installIndex = command.args.indexOf("install");
	if (installIndex === -1) return command;
	const args = [...command.args.slice(0, installIndex), "--prefix", prefix, ...command.args.slice(installIndex)];
	return {
		steps: (command.steps ?? []).map((step, index) => (index === 0 ? { ...step, args } : step)),
		command: command.command,
		args,
		display: [command.command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

/**
 * How this installation was installed.
 *
 * **The package location comes from {@link getPackageDir},** the single authority, and
 * not from `__dirname` directly. `getPackageDir()` honours `PI_PACKAGE_DIR`, which
 * `docs/environment-variables.md` documents as a supported override for Nix/Guix store
 * paths; deriving the location independently here meant the override applied to every
 * other consumer and was silently ignored for install detection, which is the same
 * split this removed.
 *
 * `process.execPath` is still consulted. It describes how the running binary was
 * launched - a fact about the process rather than a configured input - and it is what
 * distinguishes a Bun binary from a Bun global install when both are in play.
 *
 * This detects and describes; it never acts. Every consumer goes on to decide whether
 * an update may run, and the hard self-update barrier
 * (`utils/self-update-barrier.ts`, consulted in `package-manager-cli.ts` before any of
 * this is reached) is independent of what is returned here.
 */
export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${getPackageDir()}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

/**
 * The `<prefix>\node_modules` layout this installation sits in, if any.
 *
 * This is a **shape** fact only: where the directory is, not whether npm installed it
 * globally. Kept separate from {@link getInferredNpmInstall} so a refusal message can name
 * the directory pi was looking at without that becoming evidence for a self-update.
 */
function describeNpmInstallLayout(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	return { root, prefix: path.dirname(root) };
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const layout = describeNpmInstallLayout();
	if (!layout) return undefined;
	const path = process.platform === "win32" || getPackageDir().includes("\\") ? win32 : { basename, dirname };
	if (path.basename(layout.prefix) === "lib") return layout;
	// Windows global npm prefixes use `<prefix>\node_modules`, which is
	// indistinguishable from local project installs by path shape alone. Do not
	// infer unsupported Windows custom prefixes without `npm root -g` evidence.
	//
	// The shape is still reported by `describeNpmInstallLayout` so a refusal can name the
	// directory: naming it is not the same as trusting it.
	return undefined;
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updatePackageTarget: SelfUpdatePackageTarget = installedPackageName,
	npmCommand?: string[],
): SelfUpdateCommand | undefined {
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	switch (method) {
		case "bun-binary":
			return undefined;
		case "pnpm": {
			const match = readCommandOutput("pnpm", ["root", "-g"])
				? undefined
				: /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getPackageDir());
			const binDirArgs = match
				? [`--config.global-bin-dir=${process.env.PNPM_HOME || dirname(dirname(match[1]))}`]
				: [];
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", [
					"install",
					"-g",
					"--ignore-scripts",
					"--config.minimumReleaseAge=0",
					...binDirArgs,
					target.installSpec,
				]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", ...binDirArgs, installedPackageName]),
			);
		}
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", target.installSpec]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", [
					"install",
					"-g",
					"--ignore-scripts",
					"--minimum-release-age=0",
					target.installSpec,
				]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			const installStep = makeSelfUpdateCommandStep(command, [
				...prefixArgs,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				target.installSpec,
			]);
			const uninstallStep =
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep);
		}
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnProcessSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			if (root) return [root, dirname(root)];
			const match = /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getPackageDir());
			return match ? [match[1]] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string, resolveSymlinks: boolean): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath = resolvedPath;
	if (resolveSymlinks) {
		try {
			normalizedPath = realpathSync(resolvedPath);
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function getPathComparisonCandidates(path: string): string[] {
	return Array.from(
		new Set(
			[normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter(
				(candidate): candidate is string => !!candidate,
			),
		),
	);
}

function getEntrypointPackageDir(): string | undefined {
	const entrypoint = process.argv[1];
	if (!entrypoint) return undefined;
	let dir = dirname(entrypoint);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDirs = [getPackageDir(), getEntrypointPackageDir()].filter((dir): dir is string => !!dir);
	const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
	return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
		return getPathComparisonCandidates(root).some((normalizedRoot) => {
			const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
		});
	});
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageTarget, npmCommand);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
): string {
	const method = detectInstallMethod();
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	if (method === "bun-binary") {
		return `Download from: https://github.com/earendil-works/pi/releases/latest`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, target, npmCommand);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		if (method === "npm") {
			// The refusal has to be actionable. This branch is reached when
			// `getInferredNpmInstall` declined — see the comment there: on Windows a
			// `<prefix>\node_modules` shape is indistinguishable from a project-local checkout,
			// so pi will not infer a global prefix without `npm root -g` evidence. The user
			// now knows pi refuses; they do not know pi *would* update with an explicit
			// `--prefix`, nor which directory it was looking at. Both are stated here.
			//
			// Additive only: this message describes a decision `getSelfUpdateCommand` has
			// already made. No gate is relaxed and no command is permitted.
			const layout = describeNpmInstallLayout();
			if (layout) {
				return (
					`This installation is under ${layout.prefix}, which ${APP_NAME} cannot confirm is a global npm ` +
					`prefix - a \`<prefix>${sep}node_modules\` layout is indistinguishable from a project-local ` +
					`checkout - so it will not self-update here. If that prefix is yours and global, update it ` +
					`yourself with: ${npmCommandWithPrefix(command, layout.prefix).display}`
				);
			}
			return (
				`This installation is not managed by a global ${method} install. ` +
				`Update it with the package manager, wrapper, or source checkout that provides it.`
			);
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${target.installSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

// `getUpdateInstruction` used to live here. It was removed as dead exported API, not
// as a behavioural fix: it had **no production caller**, it is not re-exported from
// the package index, and no other workspace package imports it (the one
// cross-package mention of `@earendil-works/pi-coding-agent` in
// `packages/agent/src/tool-approval.ts` is a doc comment; `packages/evals` imports
// session APIs, not this).
//
// It also disagreed with the function that *is* used. `getSelfUpdateCommand` applies
// `isManagedByGlobalPackageManager` and `isSelfUpdatePathWritable`; this composed the
// ungated `getSelfUpdateCommandForMethod`, so it could say `Run: npm install -g ...`
// for an installation the gated consumer had refused. Two answers to "what should this
// user run?" from one authority - the exact split the install-method unification
// removed elsewhere. Production self-update goes through the gated function and its
// messaging goes through `getSelfUpdateUnavailableInstruction`, so nothing observable
// changes; leaving a third, contradictory answer exported only invited the split to
// recur.
//
// No compatibility alias is kept: it would preserve the redundant authority rather
// than the API. Current OMP has no equivalent function and no self-update barrier at
// all, so there is no upstream surface to stay compatible with.

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js and tsx: returns the package root containing package.json
 * - Ignores Bun binary metadata copied into dist/ when the package root is available
 */
export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			// build:binary places Bun's metadata inside dist/. Node still needs the
			// package root so its dist-relative asset paths do not become dist/dist/.
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				return parent;
			}
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	return findNodePackageDir(__dirname);
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf-8"))) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const piConfigName: string | undefined = pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const VERSION: string = pkg.version || "0.0.0";

/**
 * Environment variable names are **frozen at `PI_*`**, deliberately decoupled from
 * `APP_NAME`.
 *
 * These used to be derived as `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, which meant
 * that rebranding the product noun would have silently renamed the environment
 * variables. That would break every existing script, doc and `PI_CODING_AGENT_DIR`
 * override a user already has - `AGENTS.md`, the test suites and the acceptance harness
 * all set it. A display name must never move an identity.
 *
 * The `pi` prefix is a compatibility identifier (category B), not a product name, and it
 * stays regardless of how the product is branded. `APP_NAME` may be anything.
 */
// e.g., PI_CODING_AGENT_DIR
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
export const ENV_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID. */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.pi/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.pi/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
