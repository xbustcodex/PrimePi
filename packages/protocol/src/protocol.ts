import type { JsonValue } from "@earendil-works/chord";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

export const PROTOCOL_VERSION = 8 as const;

const IdSchema = Type.String({ minLength: 1 });
const OpaqueJsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown());
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const ServerIdSchema = Type.String({
	pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export type ServerId = Static<typeof ServerIdSchema>;

export function isServerId(value: unknown): value is ServerId {
	return Check(ServerIdSchema, value);
}

const ProtocolErrorSchema = StrictObject({
	code: IdSchema,
	message: Type.String(),
});
export type ProtocolErrorCode = string;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

/**
 * Must be the first frame sent by a client.
 *
 * `authToken` is the shared secret that proves a connecting process is the intended
 * peer. It is **optional on the wire** and **required whenever the listener demands
 * one**, so the same schema serves both platforms:
 *
 * - On POSIX a `0700` directory plus a `0600` socket already restrict the endpoint to
 *   the owner, and OMP's daemon broker sends no token there.
 * - On Windows the endpoint is a **named pipe**, and `node:net` cannot set a pipe's
 *   security descriptor, so the transport cannot restrict access to the owner. The
 *   token is what supplies that property instead.
 *
 * Current OMP reached the same conclusion from the same primitive: `node:net` bound to
 * `\\.\pipe\omp-collab-<id>` with a per-request `timingSafeEqual` bearer
 * (`collab/registry.ts:449-453, 207-211`).
 *
 * Adding this here rather than inventing a Windows-only handshake keeps authentication
 * in the one place that already fences a connection before it can reach any service.
 */
const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
	authToken: Type.Optional(Type.String()),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

/** A server-wide call, fenced to one logical server. */
const ServerTargetSchema = StrictObject({
	serverId: ServerIdSchema,
});
/** A session call, fenced to one logical server, durable session, and live attachment. */
const SessionTargetSchema = StrictObject({
	serverId: ServerIdSchema,
	sessionId: IdSchema,
	attachmentId: IdSchema,
});
export type SessionTarget = Static<typeof SessionTargetSchema>;
const RpcTargetSchema = Type.Union([ServerTargetSchema, SessionTargetSchema]);
export type RpcTarget = Static<typeof RpcTargetSchema>;

const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	target: RpcTargetSchema,
	call: OpaqueJsonValueSchema,
});
const CancelEnvelopeSchema = StrictObject({
	type: Type.Literal("cancel"),
	id: IdSchema,
	target: RpcTargetSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export type CancelEnvelope = Static<typeof CancelEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema, CancelEnvelopeSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	serverId: ServerIdSchema,
});
const ServerHelloErrorSchema = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
const ResponseEnvelopeSchema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		result: Type.Optional(OpaqueJsonValueSchema),
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: ProtocolErrorSchema,
	}),
]);
const ServiceEventEnvelopeSchema = StrictObject({
	type: Type.Literal("service_update"),
	subscriptionId: IdSchema,
	update: OpaqueJsonValueSchema,
});
/** Out-of-band update to this presentation's selected Session route. */
const AttachmentEnvelopeSchema = StrictObject({
	type: Type.Literal("attachment"),
	attachment: Type.Union([SessionTargetSchema, Type.Null()]),
});
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	ServiceEventEnvelopeSchema,
	AttachmentEnvelopeSchema,
]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type ServiceEventEnvelope = Static<typeof ServiceEventEnvelopeSchema>;
export type AttachmentEnvelope = Static<typeof AttachmentEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
