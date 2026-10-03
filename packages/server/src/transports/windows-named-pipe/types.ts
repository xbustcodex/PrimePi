import type { ServerOptions } from "../../types.ts";

/**
 * Options for a Windows named-pipe listener.
 *
 * `path` must begin with `\\.\pipe\`. There is deliberately **no** port, host, or
 * bind-address option: a named pipe is local by construction, and omitting those fields
 * is what prevents a loopback TCP endpoint from being introduced by configuration.
 */
export interface WindowsNamedPipeListenerOptions {
	/** Full pipe name, including the `\\.\pipe\` prefix. */
	path: string;
	/** Maximum framed bytes queued per connection before a slow peer is disconnected. */
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** Used to derive and validate maxPendingBytes. Must match the server when customized. */
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

export interface WindowsNamedPipeServerOptions
	extends Omit<ServerOptions, "listeners">,
		WindowsNamedPipeListenerOptions {}
