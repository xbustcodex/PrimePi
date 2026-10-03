import { posix } from "node:path";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import { type ParsedCommandInput, stringOption, valueOption } from "./command.ts";

export type AuthInput =
	| { readonly type: "token"; readonly token: string }
	| { readonly type: "file"; readonly path: string };

interface UnixTransportAddress {
	readonly transport: "unix";
	readonly path: string;
}

/**
 * A Windows named-pipe endpoint, written as `pipe:///<name>`.
 *
 * The scheme exists rather than a bare path because a pipe name is not a filesystem path:
 * `\\.\pipe\name` cannot be a URL pathname without escaping every backslash, and a
 * scheme keeps the parser's strictness (no authority, no query, no fragment) uniform across
 * both local transports.
 */
interface PipeTransportAddress {
	readonly transport: "named-pipe";
	readonly path: string;
}

interface RadiusTransportAddress {
	readonly transport: "radius";
	readonly serverId: ServerId;
}

export type TransportAddress = UnixTransportAddress | PipeTransportAddress | RadiusTransportAddress;

/**
 * The canonical Windows pipe prefix: two backslashes, a dot, backslash, "pipe", backslash.
 *
 * `String.raw` because an ordinary template literal needs four backslashes to emit one,
 * and the over-escaped version produced a name with two, which matches no pipe at all.
 * Verified by probing the parser before relying on it.
 */
const PIPE_NAME_PREFIX = String.raw`\\.\pipe\ `;

/**
 * A pipe name: two backslashes, a dot, a backslash, `pipe`, a backslash, then a
 * non-empty control-character-free name.
 *
 * Built with `RegExp` from explicit pieces rather than a literal, because the literal
 * cannot express it: `\\\`.pipe\\` parses as an escaped backslash followed by `\p`
 * (the start of a Unicode property escape), and a character class turns the following
 * `\]` into a string terminator. Both forms were tried and both were wrong.
 */
const PIPE_NAME_PATTERN = /^\\\\\.\\pipe\\[^\u0000-\u001f]+$/;

export const authTokenOption = stringOption("--auth-token");
export const authTokenFileOption = stringOption("--auth-token-file");

function parseAuthInput(options: { readonly authToken?: string; readonly authTokenFile?: string }): {
	auth?: AuthInput;
	errors: string[];
} {
	if (options.authToken !== undefined && options.authTokenFile !== undefined) {
		return { errors: ["--auth-token and --auth-token-file are mutually exclusive"] };
	}
	if (options.authToken !== undefined) {
		return { auth: { type: "token", token: options.authToken }, errors: [] };
	}
	if (options.authTokenFile !== undefined) {
		return { auth: { type: "file", path: options.authTokenFile }, errors: [] };
	}
	return { errors: [] };
}

function parseTransportAddress(value: string): { address?: TransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid --connect address "${value}"` };
	}
	if (url.protocol === "radius:") {
		if (
			url.username ||
			url.password ||
			url.port ||
			(url.pathname !== "" && url.pathname !== "/") ||
			url.search ||
			url.hash ||
			value !== `radius://${url.hostname}${url.pathname}`
		) {
			return { error: `Invalid --connect address "${value}"` };
		}
		const serverId = url.hostname;
		if (!isServerId(serverId)) {
			return { error: "Radius transport address requires a lowercase UUIDv4 server ID" };
		}
		return { address: { transport: "radius", serverId } };
	}
	if (url.protocol === "pipe:") {
		// Same strictness as the unix branch: no authority, no query, no fragment, and the
		// input must round-trip exactly, so an address cannot carry hidden content.
		if (url.hostname || url.port || url.username || url.password) {
			return { error: "Pipe transport address must not include an authority" };
		}
		if (
			!value.startsWith("pipe:///") ||
			value.startsWith("pipe:////") ||
			value.includes("?") ||
			value.includes("#") ||
			url.href !== value
		) {
			return { error: `Invalid --connect address "${value}"` };
		}
		let name: string;
		try {
			name = decodeURIComponent(url.pathname);
		} catch {
			return { error: `Invalid --connect address "${value}"` };
		}
		if (name.includes("\0")) return { error: `Invalid --connect address "${value}"` };
		// The URL requires a leading slash; the pipe prefix restores the canonical
		// `\\.\pipe\` form. Written with String.raw because a template literal needs four
		// backslashes to emit one, and an over-escaped version produced a name with two,
		// which no pipe matches.
		// The trailing space in the raw template is a delimiter, not part of the name: it
		// stops the final backslash escaping the closing backtick. Dropped explicitly rather
		// than by trimming the concatenation, which would leave a space between the prefix
		// and the name and fail the pattern below.
		const pipeName = PIPE_NAME_PREFIX.slice(0, -1) + name.replace(/^\/+/, "");
		if (!PIPE_NAME_PATTERN.test(pipeName)) {
			return { error: "Pipe transport address requires a name of the form \\\\.\\pipe\\<name>" };
		}
		return { address: { transport: "named-pipe", path: pipeName } };
	}
	if (url.protocol !== "unix:") return { error: `Unsupported --connect transport "${url.protocol}"` };
	if (url.hostname || url.port || url.username || url.password) {
		return { error: "Unix transport address must not include an authority" };
	}
	if (
		!value.startsWith("unix:///") ||
		value.startsWith("unix:////") ||
		value.includes("?") ||
		value.includes("#") ||
		url.href !== value
	) {
		return { error: `Invalid --connect address "${value}"` };
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid --connect address "${value}"` };
	}
	if (path.includes("\0")) return { error: `Invalid --connect address "${value}"` };
	if (!posix.isAbsolute(path)) return { error: "Unix transport address requires an absolute path" };
	return { address: { transport: "unix", path } };
}

export const connectOption = valueOption("--connect", (value) => {
	const result = parseTransportAddress(value);
	return result.address
		? { ok: true, value: result.address }
		: { ok: false, error: result.error ?? `Invalid --connect address "${value}"` };
});

export function parseAuth(input: ParsedCommandInput): { auth?: AuthInput; errors: string[] } {
	return parseAuthInput({
		authToken: input.value(authTokenOption),
		authTokenFile: input.value(authTokenFileOption),
	});
}

export function unsupportedOptions(command: string, input: ParsedCommandInput): string[] {
	if (input.remainingArgs.length === 0) return [];
	return [`The experimental ${command} command does not support existing CLI options yet`];
}
