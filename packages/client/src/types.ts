import type { ServiceSubscriptionSnapshot } from "@earendil-works/chord";
import type { RpcTarget, SessionTarget } from "@earendil-works/pi-protocol";
import type { ByteTransportFactory } from "./transport.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface ConnectionStateChange {
	state: ConnectionState;
	error?: Error;
}

export type Unsubscribe = () => void;
export type ListenerErrorHandler = (error: Error) => void;
export type AttachmentChangeListener = (attachment: SessionTarget | undefined) => void;

export interface ServiceSubscription {
	readonly id: string;
	readonly target: RpcTarget;
	readonly snapshot: ServiceSubscriptionSnapshot;
	/** Begin ordered update delivery after the caller has installed the snapshot. */
	start(): void;
	dispose(): Promise<void>;
}

export interface ClientOptions {
	transportFactory: ByteTransportFactory;
	/** Logical server identity expected at the physical endpoint. */
	serverId: string;
	maxFrameLength?: number;
	/**
	 * Credential presented in the `hello` frame. Required when the server requires one —
	 * always the case for a Windows named pipe, where `node:net` cannot set the pipe's
	 * security descriptor, so the credential is what proves the connecting process is the
	 * intended peer. Omit on POSIX, where the `0600` socket inside a `0700` directory
	 * already restricts the endpoint.
	 */
	authToken?: string;
	/** Reports subscriber failures without allowing them to corrupt client state. */
	onListenerError?: ListenerErrorHandler;
}
