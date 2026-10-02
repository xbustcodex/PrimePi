import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalizePath,
	getCwdRelativePath,
	isLocalPath,
	normalizePath,
	normalizeWindowsShellPath,
	resolvePath,
} from "../src/utils/paths.ts";

let tempDir: string;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

function createTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "pi-paths-"));
	return tempDir;
}

/**
 * Whether this host can create a real symbolic link.
 *
 * Windows grants `SeCreateSymbolicLinkPrivilege` to an unprivileged process only when
 * Developer Mode is on, and this machine has it off - measured rather than assumed:
 * `AllowDevelopmentWithoutDevLicense` is absent and the user holds no such privilege, so
 * `symlinkSync` throws EPERM while a junction succeeds.
 */
const canSymlink: boolean = (() => {
	try {
		const d = mkdtempSync(join(tmpdir(), "pi-paths-probe-"));
		const t = join(d, "t");
		const l = join(d, "l");
		writeFileSync(t, "x");
		symlinkSync(t, l);
		rmSync(d, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
})();

/**
 * A directory link: a real symlink where the host allows one, a junction otherwise.
 *
 * A junction is a directory reparse point, and `realpathSync` resolves one exactly as it
 * resolves a symlink - verified directly - so the directory-link property is asserted
 * for real here instead of being skipped. A *file* junction is not a file link: both
 * `realpathSync` and `readFileSync` throw ENOENT on it. So the file-link cases can only
 * run where real symlinks exist, and are skipped with the reason attached rather than
 * failing on a privilege the product itself does not depend on.
 */
function linkDirectory(target: string, link: string): void {
	symlinkSync(target, link, canSymlink ? "dir" : "junction");
}

describe("canonicalizePath", () => {
	it("returns the real path for a regular file", () => {
		const dir = createTempDir();
		const file = join(dir, "file.txt");
		writeFileSync(file, "hello");
		expect(canonicalizePath(file)).toBe(realpathSync(file));
	});

	// Skipped where the host cannot create a symbolic link at all (see canSymlink). The
	// directory case above runs everywhere; this one cannot, because a Windows file
	// junction is a directory reparse point and does not stand in for a file link.
	const symlinkOnly = canSymlink ? it : it.skip;

	symlinkOnly("resolves symlinks to their targets", () => {
		const dir = createTempDir();
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		writeFileSync(target, "hello");
		symlinkSync(target, link);
		expect(canonicalizePath(link)).toBe(realpathSync(target));
	});

	it("resolves a directory link to its target", () => {
		const dir = createTempDir();
		const targetDir = join(dir, "target-dir");
		const link = join(dir, "link-dir");
		mkdirSync(targetDir);
		linkDirectory(targetDir, link);
		expect(canonicalizePath(link)).toBe(realpathSync(targetDir));
	});

	it("falls back to the raw path when the target does not exist", () => {
		const dir = createTempDir();
		const nonexistent = join(dir, "no-such-file");
		expect(canonicalizePath(nonexistent)).toBe(nonexistent);
	});

	symlinkOnly("falls back to the raw path for a dangling symlink", () => {
		const dir = createTempDir();
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		// Create a symlink whose target does not exist.
		symlinkSync(target, link);
		// realpathSync would throw, so canonicalizePath returns the link path.
		expect(canonicalizePath(link)).toBe(link);
	});
});

describe("getCwdRelativePath", () => {
	it("keeps cwd-relative names that start with dots", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(getCwdRelativePath(join(cwd, "..config", "AGENTS.md"), cwd)).toBe(join("..config", "AGENTS.md"));
	});

	it("rejects parent-directory traversals", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(getCwdRelativePath(join(cwd, "..", "AGENTS.md"), cwd)).toBeUndefined();
	});
});

describe("resolvePath", () => {
	it("expands only home tilde shortcuts", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(normalizePath("~")).toBe(homedir());
		expect(normalizePath("~/file.txt")).toBe(join(homedir(), "file.txt"));
		expect(resolvePath("~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"));
		expect(normalizePath("~draft.md")).toBe("~draft.md");
	});

	it("resolves relative paths against the base directory", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(resolvePath("subdir/file.txt", cwd)).toBe(resolve(cwd, "subdir/file.txt"));
		expect(resolvePath("subdir/file.txt", pathToFileURL(cwd).href)).toBe(resolve(cwd, "subdir/file.txt"));
	});

	it("accepts file URLs", () => {
		const dir = createTempDir();
		const filePath = join(dir, "file with spaces.txt");
		expect(resolvePath(pathToFileURL(filePath).href, join(dir, "base"))).toBe(resolve(filePath));
	});

	it("throws for invalid file URLs", () => {
		expect(() => resolvePath("file:///%E0%A4%A")).toThrow();
	});

	it("preserves POSIX absolute paths with literal percent sequences", () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = createTempDir();
		for (const filePath of [join(dir, "report%2026.md"), join(dir, "foo%2Fbar"), join(dir, "malformed%A.md")]) {
			expect(resolvePath(filePath, join(dir, "base"))).toBe(resolve(filePath));
		}
	});

	it("does not treat Windows file URL pathname strings as native paths", () => {
		if (process.platform !== "win32") {
			return;
		}

		const dir = createTempDir();
		const filePath = join(dir, "dir", "SKILL.md");
		const pathname = pathToFileURL(filePath).pathname;
		expect(pathname).toMatch(/^\/[A-Za-z]:/);
		expect(resolvePath(pathname, "E:\\project")).toBe(resolve(pathname));
	});
});

describe("normalizeWindowsShellPath", () => {
	it("converts Git Bash, MSYS, Cygwin, and WSL drive paths", () => {
		expect(normalizeWindowsShellPath("/c/Users/example/project")).toBe("C:\\Users\\example\\project");
		expect(normalizeWindowsShellPath("/cygdrive/d/work")).toBe("D:\\work");
		expect(normalizeWindowsShellPath("/mnt/e/source")).toBe("E:\\source");
		expect(normalizeWindowsShellPath("/c")).toBe("C:\\");
	});

	it("leaves other path forms unchanged", () => {
		for (const path of [
			"C:/Users/example",
			"C:\\Users\\example",
			"//server/share/file",
			"/c/Users\\example",
			"relative/file",
			"/tmp/file",
		]) {
			expect(normalizeWindowsShellPath(path)).toBe(path);
		}
	});

	it.runIf(process.platform === "win32")("is applied by normal path handling on Windows", () => {
		expect(normalizePath("/c/Users/example")).toBe("C:\\Users\\example");
		expect(resolvePath("/mnt/c/Users/example", "D:\\work")).toBe(resolve("C:/Users/example"));
	});
});

describe("isLocalPath", () => {
	it("returns true for bare names", () => {
		expect(isLocalPath("my-package")).toBe(true);
	});

	it("returns true for relative paths", () => {
		expect(isLocalPath("./foo")).toBe(true);
	});

	it("returns true for file URLs", () => {
		expect(isLocalPath("file:///tmp/foo")).toBe(true);
	});

	it("returns false for npm: protocol", () => {
		expect(isLocalPath("npm:package")).toBe(false);
	});

	it("returns false for git: protocol", () => {
		expect(isLocalPath("git://repo")).toBe(false);
	});

	it("returns false for https: protocol", () => {
		expect(isLocalPath("https://example.com")).toBe(false);
	});
});
