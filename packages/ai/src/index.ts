export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

// Core only, side-effect free: no generated catalogs, no provider factories,
// no api-registry, no OAuth implementations, no compat. Provider factories
// live under "@earendil-works/pi-ai/providers/*", API implementations under
// "@earendil-works/pi-ai/api/*", the old global API under
// "@earendil-works/pi-ai/compat".
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./api/anthropic-messages.ts";
export type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
export type { BedrockOptions, BedrockThinkingDisplay } from "./api/bedrock-converse-stream.ts";
export type { GoogleOptions } from "./api/google-generative-ai.ts";
export type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./api/google-shared.ts";
export type { GoogleVertexOptions } from "./api/google-vertex.ts";
export * from "./api/lazy.ts";
export type { MistralOptions } from "./api/mistral-conversations.ts";
export type { OpenAICodexResponsesOptions, OpenAICodexWebSocketDebugStats } from "./api/openai-codex-responses.ts";
export type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
export type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
export type { PiMessagesEvent, PiMessagesOptions, PiMessagesRewriteImpact } from "./api/pi-messages.ts";
export * from "./auth/context.ts";
export * from "./auth/credential-store.ts";
export * from "./auth/helpers.ts";
export * from "./auth/types.ts";
export type {
	OAuthAuthInfo,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
export * from "./models.ts";
export * from "./models-store.ts";
export * from "./providers/faux.ts";
export * from "./session-resources.ts";
export * from "./types.ts";
export {
	type AutoRedeemPolicy,
	creditsExpiringWithin,
	decideRedeem,
	isAnswered,
	mintRedeemRequestId,
	pickSoonestExpiringCredit,
	type RedeemDecision,
	type ResetCredit,
	type StuckTurnEvidence,
} from "./usage/reset-credits.ts";
export * from "./utils/assistant-message-frame.ts";
export { type AvailabilityFailure, classifyAvailabilityFailure, type FailureScope } from "./utils/availability.ts";
export { AvailabilityCooldowns, type UnavailabilityEntry } from "./utils/availability-cooldowns.ts";
export {
	autoFallbackFor,
	CACHE_RETENTION_ENV,
	type CacheRetentionSetting,
	describeRetention,
	type RetentionResolution,
	resolveCacheRetention,
	retentionTtlMs,
	supportsCacheRetention,
} from "./utils/cache-retention.ts";
export * from "./utils/diagnostics.ts";
export * from "./utils/event-stream.ts";
export {
	type FailoverCandidateInput,
	type FailoverDecision,
	type FailoverPolicy,
	failoverNotice,
	policyAllowsPaid,
	selectFailoverCandidate,
	type TurnRequirements,
	type UnavailableReason,
} from "./utils/failover.ts";
export { isAnonymouslyAccessible, isCredentialFree } from "./utils/free-model.ts";
export * from "./utils/json-parse.ts";
export {
	type AnnotatedPattern,
	activeRoles,
	type CandidateThinking,
	DEFAULT_ROLE_ALIAS,
	evaluateEligibility,
	expandRolePatterns,
	formatRoleAlias,
	type IneligibleReason,
	isModelRole,
	isRoleAlias,
	isThinkingLevel,
	MODEL_ROLE_IDS,
	MODEL_ROLES,
	type ModelRole,
	type ModelRoleInfo,
	preferenceRank,
	type RejectedCandidate,
	type RoleChainCandidate,
	type RoleChainInput,
	type RoleChainResult,
	type RoleEligibility,
	type RolePreferences,
	type RoleResolution,
	type RoleThinkingLevel,
	resolveRoleAlias,
	resolveRoleCandidates,
	resolveRoleChain,
	splitThinkingSuffix,
	THINKING_LEVELS,
} from "./utils/model-roles.ts";
export * from "./utils/overflow.ts";
export {
	type AdmitDecision,
	admitRequest,
	backoffMs,
	describeLimits,
	InvalidProviderLimitError,
	limitFor,
	type ProviderLimits,
	type ProviderUsage,
	validateProviderLimits,
} from "./utils/provider-limits.ts";
export * from "./utils/retry.ts";
export {
	describeTimeout,
	parseTimeoutSeconds,
	type StreamTimeoutSetting,
	TIMEOUT_AUTO,
	timeoutSecondsToMs,
	type WatchdogOptions,
	withStreamWatchdog,
} from "./utils/stream-watchdog.ts";
export { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./utils/text.ts";
export {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampThinkingLevelForModel,
	concreteThinkingLevel,
	INHERIT_THINKING,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	supportedThinkingLevels,
} from "./utils/thinking-level.ts";
export {
	type RepeatedToolCallDetection,
	ToolCallLoopGuard,
	type ToolCallLoopGuardOptions,
	type ToolCallLoopTurn,
} from "./utils/tool-call-loop-guard.ts";
export * from "./utils/transcript.ts";
export * from "./utils/typebox-helpers.ts";
export { uuidv7 } from "./utils/uuid.ts";
export * from "./utils/validation.ts";
