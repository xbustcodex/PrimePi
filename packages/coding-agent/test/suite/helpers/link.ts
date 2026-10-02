import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Directory links for hosts that cannot create symbolic links.
 *
 * Windows grants `SeCreateSymbolicLinkPrivilege` to an unprivileged process only when
 * Developer Mode is on. Measured on this machine: `AllowDevelopmentWithoutDevLicense` is
 * absent and the account holds no such privilege, so `symlink` throws EPERM while a
 * **junction** succeeds.
 *
 * A junction is a directory reparse point, and `realpath`/`realpathSync` resolve one
 * exactly as they resolve a symlink - verified directly. So for any property expressed
 * as "two names for one path resolve to one thing", a junction is a faithful stand-in
 * and the test can run rather than be skipped.
 *
 * It is not a stand-in for a *file* link: a Windows file junction is still a directory
 * reparse point, and both `realpath` and `readFile` throw ENOENT on it. Tests that need a
 * genuine file symlink must skip, with the reason attached.
 */

let cached: Promise<"dir" | "junction"> | undefined;

/** `"dir"` where real symlinks work, `"junction"` otherwise. */
export function directoryLinkType(): Promise<"dir" | "junction"> {
	cached ??= (async () => {
		try {
			const d = await mkdtemp(join(tmpdir(), "pi-linkprobe-"));
			const t = join(d, "t");
			await mkdir(t, { recursive: true });
			await symlink(t, join(d, "l"), "dir");
			return "dir" as const;
		} catch {
			return "junction" as const;
		}
	})();
	return cached;
}

/** Whether this host can create a genuine symbolic link of any kind. */
export async function canCreateSymlinks(): Promise<boolean> {
	if ((await directoryLinkType()) === "dir") return true;
	try {
		const d = await mkdtemp(join(tmpdir(), "pi-linkprobe-f-"));
		const f = join(d, "f.txt");
		await symlink(f, join(d, "l.txt"));
		return true;
	} catch {
		return false;
	}
}

/** A directory link appropriate to this host. Throws if neither form is permitted. */
export async function makeDirectoryLink(target: string, link: string): Promise<void> {
	await symlink(target, link, await directoryLinkType());
}
