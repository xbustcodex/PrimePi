/**
 * A minimal logger for `tui`.
 *
 * The reference imports one from `pi-utils`. Prime Pi has no `pi-utils` package, and the only
 * thing the ported surfaces need is a sink that writes to stderr without going through the TUI's
 * own stdout - a component that logged through stdout would corrupt the frame.
 *
 * Kept deliberately small: three levels and no configuration. A surface that needs structured
 * logging is asking for something this package does not have, and inventing a logging framework
 * here would be a second answer to a question the application already answers.
 */

/** Where a log line goes. */
export type LogSink = (level: "error" | "warn" | "info", message: string) => void;

/**
 * The default sink: stderr, one line per message.
 *
 * Timestamps are omitted deliberately. A TUI log is read alongside the terminal, where a
 * timestamp is noise; a server-side log should use the application's own logger instead.
 */
const stderrSink: LogSink = (level, message) => {
	process.stderr.write(`[tui:${level}] ${message}\n`);
};

/**
 * Structured detail attached to a log line.
 *
 * Rendered as `key=value` pairs after the message. Values are JSON-encoded when they are not
 * strings, so an `Error` prints its stack rather than `{}`.
 */
export type LogMeta = Record<string, unknown>;

function withMeta(message: string, meta?: LogMeta): string {
	if (!meta) return message;
	const parts: string[] = [];
	for (const [key, value] of Object.entries(meta)) {
		parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return parts.length > 0 ? `${message} ${parts.join(" ")}` : message;
}

export const logger = {
	/** Something failed and the user may need to know why. */
	error(message: string, meta?: LogMeta): void {
		stderrSink("error", withMeta(message, meta));
	},
	/** Something is unexpected but recoverable. */
	warn(message: string, meta?: LogMeta): void {
		stderrSink("warn", withMeta(message, meta));
	},
	/** Diagnostic detail, on by default because a TUI has no log file to write into. */
	info(message: string, meta?: LogMeta): void {
		stderrSink("info", withMeta(message, meta));
	},
};
