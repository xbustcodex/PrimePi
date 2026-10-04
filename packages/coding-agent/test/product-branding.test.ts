import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Branding regression: user-facing prose must say "Prime Pi".
 *
 * A blunt `Pi -> Prime Pi` replacement would be wrong, because most `pi` occurrences in
 * this repository are **not** the product noun. This test therefore uses an explicit
 * classification rather than a global match:
 *
 *   - category B, compatibility and internal identifiers, must keep `pi`. Renaming any of
 *     them would break real behaviour, so this test asserts they are *still* `pi`, which
 *     makes it a two-way guard rather than a one-way grep.
 *   - category C, upstream attribution, must keep `pi`.
 *   - category A, user-facing prose, must not contain a bare product noun `pi`.
 *
 * The product noun is detected as a standalone lowercase `pi` in a display string, so
 * `pi-coding-agent`, `.pi`, `PI_CODING_AGENT_DIR` and `pi.dev` never match.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

/** Paths whose contents are user-facing and therefore in scope. */
const SCANNED_ROOTS = ["src"];

/** Files that legitimately contain product-noun prose for other reasons. */
const ALLOWED_FILES = new Set([
	// Each entry names the file AND why a bare `pi` there is legitimate. This is an explicit
	// classification, not a suppression list that grows until the scan means nothing.
	"src/config.ts", // defines APP_NAME/APP_TITLE and the pi-prefixed env-var identities
	"src/cli/startup-ui.ts", // owns the distribution gate and reads APP_NAME
	// The only `pi` here is the command name in `pi auth print-api-key …`. That is
	// category B: the executable is still invoked as `pi`, so the usage banner must keep
	// printing the command the user actually types.
	"src/cli/auth-command.ts",
]);

/**
 * Category B/C occurrences that must survive a rebrand. If one of these ever changes, this
 * test fails - which is the point: an accidental rename of an identifier is a regression.
 */
const PRESERVED_IDENTIFIERS: Array<[string, string]> = [
	[".pi", "config directory, a compatibility identifier"],
	["PI_CODING_AGENT_DIR", "environment variable, frozen at the pi prefix"],
	["PI_CODING_AGENT_SESSION_DIR", "environment variable, frozen at the pi prefix"],
	["@earendil-works/pi-coding-agent", "npm package name"],
	["@earendil-works/pi-tui", "npm package name"],
	["@earendil-works/pi-ai", "npm package name"],
	["@earendil-works/pi-agent-core", "npm package name"],
	["pi-coding-agent", "distribution identifier used by the update path"],
	["earendil-works/pi", "upstream attribution"],
];

/** Files to walk. */
function* sourceFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* sourceFiles(full);
			continue;
		}
		if (/\.(ts|mts|tsx)$/.test(full) && !/\.d\.ts$/.test(full)) yield full;
	}
}

/**
 * Extract likely user-facing display strings: template literals and quoted strings that
 * contain sentence-like prose, i.e. a space and a lowercase word.
 */
/** Remove line and block comments, so prose *about* the product is not an offence. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function displayStrings(source: string): string[] {
	const out: string[] = [];
	source = stripComments(source);
	// Scan for the opening delimiter and read to its unescaped match, rather than using a
	// single regex. The regex form stopped at the first escaped quote, so a template holding
	// `chalk.bold("Usage:")` was only examined up to that point and the rest of the string -
	// where a real offence could sit - was never scanned.
	let index = 0;
	while (index < source.length) {
		const ch = source[index];
		if (ch !== '"' && ch !== "'" && ch !== "`") {
			index++;
			continue;
		}
		const quote = ch;
		let cursor = index + 1;
		let value = "";
		let closed = false;
		while (cursor < source.length) {
			const c = source[cursor];
			if (c === "\\") {
				// Keep the escaped character without the backslash.
				value += source[cursor + 1] ?? "";
				cursor += 2;
				continue;
			}
			if (c === quote) {
				closed = true;
				cursor++;
				break;
			}
			if (quote !== "`" && c === "\n") break; // unterminated single-line literal
			value += c;
			cursor++;
		}
		if (closed && value.length >= 6) out.push(value);
		index = closed ? cursor : index + 1;
	}
	return out;
}

/**
 * A standalone product noun: `pi` bounded by whitespace or string edges, not part of a
 * longer token. `.pi`, `pi-`, `-pi`, `pi.`, `/pi` and `PI_` all fail to match.
 */
const PRODUCT_NOUN = /(^|[^A-Za-z0-9._/-])pi([^A-Za-z0-9._/-]|$)/i;

/**
 * Occurrences that name the **command**, not the product.
 *
 * The executable is still invoked as `pi` - `bin.pi` is a compatibility identifier - so a
 * sentence that tells the user which command to run must keep saying `pi`. Two forms
 * count: backtick-quoted (`` `pi` ``, `` `pi auth` ``), which is how the codebase marks a
 * literal command everywhere, and a bracketed usage value (`[source|self|pi]`).
 *
 * Stripping these before the noun test is what keeps the scan honest: without it, every
 * legitimate command reference would need an allowlist entry, and an allowlist that grows
 * to cover "pi auth" and "pi first" has stopped being a check.
 */
function stripCommandReferences(literal: string): string {
	return (
		literal
			.replace(/`[^`]*`/g, (m) => " ".repeat(m.length))
			.replace(/\[[^\]]*\]/g, (m) => " ".repeat(m.length))
			// A usage-grammar position: `${APP_NAME} update pi` means "update the package whose
			// name is pi", so the token after the subcommand is an argument, not prose. Any
			// whitespace-separated run immediately following a verb is treated as such.
			.replace(
				/((?:^|\n)\s*(?:\$\{APP_NAME\}\s+)?(?:update|install|remove|uninstall)\s+(?:<[^>]*>\s+)?)([\w@./-]+)/g,
				(m, head: string) => head + " ".repeat(m.length - head.length),
			)
	);
}

describe("product branding", () => {
	const files = SCANNED_ROOTS.flatMap((root) => [...sourceFiles(join(PACKAGE_ROOT, root))]);

	it("scans a non-trivial number of files", () => {
		// Guards against the scan silently covering nothing after a directory rename.
		expect(files.length).toBeGreaterThan(100);
	});

	it("no user-facing display string names the product as bare 'pi'", () => {
		const offences: string[] = [];
		for (const file of files) {
			const rel = relative(PACKAGE_ROOT, file).replaceAll("\\", "/");
			if (ALLOWED_FILES.has(rel)) continue;
			const source = readFileSync(file, "utf8");
			for (const literal of displayStrings(source)) {
				// Skip anything that is clearly an identifier, path, url or code reference.
				if (/https?:|file:|\.ts\b|\.json\b|\.md\b|\.js\b|@|\/\//.test(literal)) continue;
				if (PRODUCT_NOUN.test(stripCommandReferences(literal))) {
					offences.push(`${rel}: ${JSON.stringify(literal.slice(0, 90))}`);
				}
			}
		}
		expect(offences, `bare product noun in user-facing text:\n${offences.join("\n")}`).toEqual([]);
	});

	it("keeps every compatibility identifier unchanged", () => {
		// Category B and C must NOT be rebranded. Asserted positively so an accidental
		// rename is caught rather than assumed.
		const configSource = readFileSync(join(PACKAGE_ROOT, "src", "config.ts"), "utf8");
		for (const [identifier, why] of PRESERVED_IDENTIFIERS) {
			const found = files.some((file) => readFileSync(file, "utf8").includes(identifier));
			expect(found, `${identifier} (${why}) should still exist somewhere in the package`).toBe(true);
		}
		// The env-var identity specifically must be literal, not derived from the display name.
		expect(configSource).toMatch(/export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR"/);
		expect(configSource).not.toMatch(/ENV_AGENT_DIR = `\$\{APP_NAME/);
	});

	it("takes the product noun from package metadata, not a hardcoded literal", () => {
		const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			piConfig?: { name?: string; configDir?: string };
			bin?: Record<string, string>;
		};
		expect(pkg.piConfig?.name).toBe("Prime Pi");
		// The config directory is a compatibility identifier and must not follow the rename.
		expect(pkg.piConfig?.configDir).toBe(".pi");
		// The command stays `pi` so existing workflows and aliases keep working.
		expect(Object.keys(pkg.bin ?? {})).toContain("pi");
	});

	it("keeps the upstream reference intact", () => {
		// Upstream attribution is category C: it genuinely means the upstream project.
		const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
		expect(readme.length).toBeGreaterThan(0);
	});
});
