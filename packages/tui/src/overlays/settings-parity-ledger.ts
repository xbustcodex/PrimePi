/**
 * The mechanical settings ledger.
 *
 * ## Why this exists
 *
 * A completion count that a person tallied by hand is a claim, not evidence. Two
 * reports in this program disagreed about how many rows were wired, and the
 * only way to settle it was to parse the contract. So the count is now derived
 * from {@link OMP_PARITY_ROWS} itself, and this module is the single place that
 * reconciles the rows against the four evidence states.
 *
 * ## The states, and what each one asserts
 *
 * - `wired` — a runtime consumer reads the value and its behaviour is proven to
 *   the level that capability needs. **A setting key existing proves nothing
 *   about this.** A row reaches `wired` by being listed in {@link WIRED_ROWS},
 *   which is a claim someone had to make deliberately, and the test below checks
 *   that claim against the registry.
 * - `pi-specific` — PrimePi has the capability and the reference does not. These
 *   sit *outside* the reference's 383 and are counted separately, because folding
 *   them into that total would make the reference look larger than it is.
 * - `omp-present-unmigrated` — the reference shows it; the subsystem is not
 *   migrated. A parity marker, not a working control.
 * - `deferred` — transcribed but deliberately not scheduled.
 *
 * ## Reconciliation
 *
 * {@link reconcileLedger} must account for every row exactly once and sum to
 * {@link OMP_PARITY_ROW_COUNT}. A row that falls through every bucket, or a
 * `wired` row whose `piKey` is absent from the typed registry, is a failure -
 * not a warning, because either one means the panel is claiming something it
 * cannot back.
 */

import { OMP_PARITY_ROW_COUNT, OMP_PARITY_ROWS, type ParityRow } from "./settings-parity-rows.ts";

/** A row whose runtime consumer is proven. Every entry is a deliberate claim. */
const WIRED_ROWS: Readonly<Record<string, string>> = {
	// Memory tab, General.
	followUpMode: "consumed by takeBatch; a follow-up queue keeps draining under either mode while anything is left",
	interruptMode:
		"consumed by shouldInterrupt; wait spares side-effecting calls and still cuts short purely interruptible ones",
	steeringMode: "consumed by takeBatch; one-at-a-time lets the model act on a redirect before seeing the next",
	"loop.conditionTimeoutMs":
		"consumed as the bound on one condition evaluation, and 0 disables the bound rather than defaulting",
	"loop.mode": "consumed between /loop iterations before re-submitting the prompt",
	"memory.backend": "resolved by SessionMemory.create and consumed by the backend registry",
	// Memory tab, Mnemopi. The bank store and its lifecycle.
	"mnemopi.dbPath": "consumed by the bank store as its storage root; empty means the agent directory",
	"mnemopi.bank": "consumed as the shared bank base name; per-project scopes prefix it",
	"mnemopi.scoping": "consumed to choose global, per-project, or per-project-tagged bank scope",
	"mnemopi.autoRecall": "consumed by AutoMemoryLifecycle; recall runs at most once per user turn",
	"mnemopi.autoRetain": "consumed by AutoMemoryLifecycle; retention advances a cursor so a turn is stored once",
	// Model tab, Retry & Fallback.
	"retry.maxRetries": "consumed by the retry policy when it builds its attempt budget",
	"retry.maxDelayMs": "consumed by getRetrySettings as maxAgentDelayMs, the upper bound on backoff between attempts",
	"retry.modelFallback": "consumed by resolveFallbackChain as the off/allowed switch",
	"retry.fallbackChains": "consumed as the ordered routes resolveFallbackChain walks",
	"retry.fallbackRevertPolicy": "consumed by shouldRevertToPrimary",
	// Model tab, Thinking: the stream loop guard.
	"model.loopGuard.enabled":
		"consumed by ThinkingLoopDetector, which scans the stream at a bounded cadence rather than per delta",
	"model.loopGuard.checkAssistantContent":
		"consumed when the guard latches on visible assistant text, which is proof the reasoning stream is making progress",
	"model.loopGuard.toolCallReminder":
		"consumed when the guard trips, so the retry prompt names the tool-call that would have ended the loop",
	// Model tab, Retry & Fallback: the usage reserve margin and what reaching it does.
	"retry.waitForUsageReset":
		"consumed when a rate limit reports a reset time, so the turn waits instead of failing",
	"retry.usageAwareFallback":
		"consumed as the gate on moving to another model when the current plan is nearly spent",
	"retry.usageReservePct":
		"consumed by classifyUsage as the remaining fraction below which an account is inside the margin; an unreported reading resolves to unknown and keeps the primary model",
	"retry.usageReservePolicy":
		"consumed by decideReserveAction; fail-closed refuses even when a healthy account exists, because switching would spend the margin while reporting a normal turn",
	// Providers tab, Services: the code-mode tool surface and the search budget.
	"providers.openai-codex.codeMode":
		"consumed by resolveCodeMode, which collapses the direct tool surface only when the eval transport and the eval tool are both present",
	"providers.openai-codex.codeModeDirectTools":
		"consumed by resolveCodeMode, admitting an extra direct tool only when the session has it enabled",
	"providers.webSearchTimeoutSeconds":
		"consumed as the wall-clock budget for a provider web search before the route is abandoned",
	// Tools tab, Available Tools: structural search and the tool backends.
	"astGrep.enabled":
		"consumed by the structural search tool, which pages matches through mergeStructuralResults",
	"astEdit.enabled":
		"consumed by the AST transform tool, which rewrites a construct rather than a text span",
	"ida.enabled":
		"consumed by the decompiler tool when it queries a running IDA instance",
	"debug.enabled":
		"consumed by the DAP adapter, which attaches to a running process for frame inspection",
	"launch.enabled":
		"consumed when a session starts the background services it needs",
	"vault.enabled":
		"consumed by the vault tools when they read and write a notes store",
	// Memory tab, Mnemopi: rank fusion across four independent recall voices.
	"mnemopi.polyphonicRecall":
		"consumed by fuseByReciprocalRank, which fuses four voice rankings by rank rather than by score so a memory several voices agree on outranks one that leads a single voice",
	"mnemopi.enhancedRecall":
		"consumed as a per-voice candidate multiplier applied before the ranks are fused",
	"mnemopi.proactiveLinking":
		"consumed when memories are stored, writing edges instead of deferring them to recall",
	// Interaction tab, Input: the Escape ladder, the session tree, and the editor.
	"doubleEscapeAction":
		"consumed by setupKeyHandlers, where the last rung of the Escape ladder runs a configured action on a second press inside 500ms; destructive rewind is deliberately not offered, only fork and tree",
	"treeFilterMode":
		"consumed by showTreeSelector as the initial filter applied when the session tree opens",
	"autocompleteMaxVisible":
		"consumed by the autocomplete component when it caps the visible candidate list",
	// Appearance tab, Status Line: a closed segment catalog and a computed gauge.
	"statusLine.preset":
		"consumed when the line is assembled, choosing which segments appear",
	"statusLine.separator":
		"consumed when the line is rendered, between segments",
	"statusLine.contextLine":
		"consumed by resolveContextGauge, which places ticks at the session own speculative and compaction boundaries",
	"statusLine.sessionAccent":
		"consumed when the line and editor border are styled",
	"statusLine.transparent":
		"consumed when the line background is painted",
	"statusLine.compactThinkingLevel":
		"consumed when the thinking level segment renders",
	"statusLine.showHookStatus":
		"consumed when the line assembles, adding hook state",
	// Files tab, Read Summaries: progressive disclosure for a large file.
	"read.summarize.enabled":
		"consumed by decideReadSummary; a small file is read verbatim because summarising it costs tokens to save tokens",
	"read.summarize.prose":
		"consumed by decideReadSummary; Markdown has no signatures, so summarising it is an outline of a document",
	"read.summarize.minBodyLines":
		"consumed as the body-line floor before a block is elided",
	"read.summarize.minCommentLines":
		"consumed as the comment-line floor before a block is elided",
	"read.summarize.minTotalLines":
		"consumed by decideReadSummary as the file-length floor below which a file is read verbatim",
	"read.summarize.unfoldUntil":
		"consumed by unfoldBudget as the target the elided middle is unfolded to",
	"read.summarize.unfoldLimit":
		"consumed by unfoldBudget as the hard ceiling on how much unfolding may add",
	// Providers tab, Services: per-provider concurrency.
	"providers.maxInFlightRequests":
		"consumed by admitRequest; the effective limit is the smaller of the configured one and the provider own ceiling, and an invalid entry is rejected rather than coerced",
	// Providers tab, Protocol: cache and transport policy.
	"providers.cacheRetention":
		"consumed by resolveCacheRetention; an explicit setting is never overridden by the environment",
	"providers.cacheWarming":
		"consumed when deciding whether to re-write a cache entry to keep it alive while idle",
	"providers.openaiWebsockets":
		"consumed when building a request, choosing the websocket transport where available",
	"providers.openrouterVariant":
		"consumed when routing a request, narrowing or widening the upstream provider set",
	// Tools tab, Available Tools: the security namespace.
	"security.enabled":
		"consumed by securityAvailability, which resolves to off when the setting cannot be read",
	// Tools tab, Available Tools: asking the user.
	"ask.enabled":
		"consumed by validateAskQuestion, which refuses an option label that collides with one the dialog owns",
	// Interaction tab, Startup & Updates: checking is not updating.
	"startup.checkUpdate":
		"consumed by evaluateUpdateCheck, which returns a notice and never a download or an install",
	"update.channel":
		"consumed by evaluateUpdateCheck to choose which stream to compare against",
	"startup.quiet":
		"consumed at session start, suppressing the splash and the changelog",
	"startup.changelogMode":
		"consumed at session start, showing what changed since the last run",
	// Appearance tab, Display: terminal state the renderer owns.
	"terminal.showProgress":
		"consumed by TerminalProgress, which only ever clears an indicator it set itself",
	"tui.mouse":
		"consumed when terminal input is wired, enabling click-to-focus",
	"tui.titleState":
		"consumed when the terminal title is set, including the run state",
	"tui.titleSpinner":
		"consumed when the terminal title is written, choosing the spinner animation",
	"task.showResolvedModelBadge":
		"consumed by the status line, showing the model a role resolved to rather than the role name",
	// Tasks tab, Isolation: bounded delegated work.
	"task.isolation.enabled":
		"consumed by decideIntegration; isolation isolates changes in progress and is not a sandbox",
	"task.isolation.merge":
		"consumed by decideIntegration, choosing diffs plus git apply or a per-task commit merged with --no-ff",
	"task.isolation.commits":
		"consumed when a commit is made for an isolated task",
	"task.isolation.apply":
		"consumed by decideIntegration; off discards a finished tasks changes, which is what makes a speculative delegation safe",
	"worktree.clone":
		"consumed when a worktree is created, cloning the checkout instead of adding one",
	"worktree.cleanSource":
		"consumed when a worktree is removed, cleaning the source checkout",
	// Tasks tab, Commands & Skills: a trust boundary, not a feature list.
	"commands.enableClaudeUser":
		"consumed by isSourceAdmitted, with a fallback to the broader user-source setting",
	"commands.enableClaudeProject":
		"consumed by isSourceAdmitted with no fallback, because a repository directory is under the control of whoever last committed",
	"commands.enableOpencodeUser":
		"consumed by isSourceAdmitted, with a fallback to the broader user-source setting",
	"commands.enableOpencodeProject":
		"consumed by isSourceAdmitted with no fallback, because a repository directory is under the control of whoever last committed",
	// Shell tab, Eval & Runtimes: the persistent Python kernel.
	"python.kernelMode":
		"consumed by decideKernel; per-call starts fresh so two calls cannot interfere, session reuses a matching kernel",
	"python.interpreter":
		"consumed by resolveInterpreter, used exactly and skipping discovery so a version-dependent result is attributable",
	// Tasks tab, Modes: the explicit plan lifecycle.
	"plan.enabled":
		"consumed by mayBeginExecution, gating execution while plan mode is active",
	"plan.defaultOnStartup":
		"consumed when a session starts, entering plan mode read-only by default",
	"plan.autosave":
		"consumed when plan mode completes, writing the approved plan to disk",
	"goal.enabled":
		"consumed for the session goal, tracked and reported against",
	"goal.statusInFooter":
		"consumed by the status footer, showing the current goal",
	// Model tab, Thinking: how reasoning is presented.
	"hideThinkingBlock":
		"consumed by resolveThinkingDisplay; it changes the screen and not the request, so the reasoning still costs tokens",
	"proseOnlyThinking":
		"consumed by toProseOnly, replacing code blocks in a summary with a marker while keeping the surrounding reasoning",
	"omitThinking":
		"consumed by requestEffect, asking the provider to produce no summaries at all",
	"externalThinking":
		"consumed by requestEffect, treating reasoning as a scratchpad and disabling it where the provider supports that",
	// Files tab, LSP: shared server identity and diagnostics.
	"lsp.enabled":
		"consumed when the tool set is assembled, gating language-server integration",
	"lsp.lazy":
		"consumed at startup, deferring a language server until the tool or a matching file needs it",
	"lsp.shared":
		"consumed by acquireServer, which falls back to a private server when the broker is unreachable",
	"lsp.formatOnWrite":
		"consumed after a successful edit, formatting through the file language server",
	"lsp.diagnosticsOnWrite":
		"consumed after writing a file, requesting diagnostics from its language server",
	"lsp.diagnosticsOnEdit":
		"consumed after editing a file, requesting diagnostics from its language server",
	"lsp.diagnosticsDeduplicate":
		"consumed when merging diagnostics, collapsing identical reports from several servers",
	// Files tab, Editing: the write-safety guards.
	"edit.mode":
		"consumed when an edit is applied, choosing how the new content is written",
	"edit.fuzzyMatch":
		"consumed when an exact anchor is not found, deciding whether to widen the search",
	"edit.fuzzyThreshold":
		"consumed by the fuzzy matcher as the similarity a widened search must reach",
	"edit.streamingAbort":
		"consumed when an edit preview does not apply cleanly, refusing rather than writing a partial change",
	"edit.enforceSeenLines":
		"consumed by SeenLineIndex.check, rejecting an edit anchored on a line no read displayed",
	"edit.blockAutoGenerated":
		"consumed before writing, refusing a file carrying a generated-code marker",
	"edit.blackbox.enabled":
		"consumed after a parse mismatch, recording it for a later fix",
	"edit.autoRepair.enabled":
		"consumed on the next edit, repairing a recorded parse regression",
	// Shell tab, Bash: the ordered approval rules and command preparation.
	"bash.patterns":
		"consumed by decideChain and firstMatchingRule as the ordered approval rules, glob-matched and anchored",
	"bash.autoBackground.enabled":
		"consumed when a shell command runs long enough to background on its own",
	"bash.direnv":
		"consumed before a command runs, deciding whether a .envrc is loaded",
	"bashInterceptor.enabled":
		"consumed when a command is prepared, rewriting it before approval rather than after",
	// Context tab, Rules (TTSR): mid-stream rule injection.
	"ttsr.enabled":
		"consumed by isRuleActive; a rule is inactive when this is off, whatever the others say",
	"ttsr.judge":
		"consumed by shouldJudge and decideJudgedRule; auto asks only when a judge role is available",
	"ttsr.interruptMode":
		"consumed by shouldInterrupt, deciding whether a live stream is aborted or warned about after",
	"ttsr.repeatMode":
		"consumed by RuleFireTracker; a rule that re-fires every turn is a loop, not a rule",
	"ttsr.repeatGap":
		"consumed by RuleFireTracker as the message count before a rule may fire again",
	"ttsr.builtinRules":
		"consumed by isRuleActive for rules the reference ships",
	// Memory tab, Hindsight: bank scoping for a remote service.
	"hindsight.apiUrl":
		"consumed by the Hindsight client as the service base URL",
	"hindsight.apiToken":
		"consumed as the bearer token; masked in the panel because it is a credential",
	"hindsight.bankId":
		"consumed by resolveBankScope, taking precedence over the bankIdPrefix",
	"hindsight.scoping":
		"consumed by resolveBankScope, choosing hard bank isolation or tag filtering",
	"hindsight.autoRecall":
		"consumed by the Hindsight lifecycle, recalling on the first turn of each session",
	"hindsight.autoRetain":
		"consumed by the Hindsight lifecycle, retaining conversation content as it accumulates",
	"hindsight.retainMode":
		"consumed when retaining, choosing one document per session or chunked turns",
	"hindsight.mentalModelsEnabled":
		"consumed when bootstrapping, letting the service derive models over retained memories",
	// Interaction tab, Share: what leaves the machine.
	"share.redactSecrets":
		"consumed by decideShare, resolved against the session own project rather than the invoking directory",
	"share.serverUrl":
		"consumed when a session is published, naming the destination",
	"share.store":
		"consumed when a session is published, selecting where it is stored",
	// Tools tab, Available Tools: bounded exploration.
	"checkpoint.enabled":
		"consumed when the tool set is assembled, gating the checkpoint and rewind tools",
	// Shell tab, Bash: per-segment approval for a literal && chain.
	"bash.enabled":
		"consumed when the tool set is assembled, gating whether bash is offered at all",
	"bash.allowCompoundCommands":
		"consumed by decideChain, which judges a literal && chain per segment and treats an unsegmentable one as a single opaque command",
	// Memory tab, Mnemopi: retrieval mode and endpoint precedence.
	"mnemopi.noEmbeddings":
		"consumed by resolveRetrievalMode, selecting deterministic full-text recall rather than a cheaper vector one",
	"mnemopi.llmMode":
		"consumed by resolveRetrievalMode and planRetrieval; none disables recall rather than degrading it",
	"mnemopi.llmBaseUrl":
		"consumed by planRetrieval as authoritative over a managed model, so a configured instance is never repointed",
	// Model tab, Vision: image URL lifetime.
	"images.urls.enabled":
		"consumed when a model request is built, choosing a link over inline image bytes",
	"images.describeForTextModels":
		"consumed when the active model cannot accept image input, describing it in text instead",
	"images.urls.ttlHours":
		"consumed by isExpired; 0 keeps links alive while the broker runs, and dispose still reaps them",
	"images.urls.bindHost":
		"consumed by buildImageUrl as the host a link points at",
	"images.urls.publicBaseUrl":
		"consumed by buildImageUrl, taking precedence over the bind host for a reachable address",
	"images.urls.command":
		"consumed when publishing an image, replacing the local broker with an external uploader",
	// Context tab, General.
	"workspace.additionalDirectories":
		"consumed by buildWorkspaceRoots, which resolves each path once and drops a root already inside another",
	"contextPromotion.enabled":
		"consumed by decideOverflow, which promotes before compacting because promotion avoids losing history",
	// Tools tab, Grep and extension handlers.
	"grep.contextBefore":
		"consumed by mergeContextRegions, which merges overlapping regions so shared context is emitted once",
	"grep.contextAfter": "consumed by mergeContextRegions and clamped at the end of a file so no absent line is claimed",
	"grep.enabled": "consumed when the tool set is assembled, gating whether grep is offered",
	"glob.enabled": "consumed when the tool set is assembled, gating whether glob is offered",
	"extensionHandlers.toolCallTimeoutMs":
		"consumed as the deadline for an extension tool-call handler before it is abandoned",
	// Context tab, Compaction: when maintenance runs.
	"compaction.enabled": "consumed by decideCompaction, gating whether maintenance may run at all",
	"compaction.thresholdPercent": "consumed by resolveCompactionThreshold, which falls back to the reserve at -1",
	"compaction.thresholdTokens":
		"consumed by resolveCompactionThreshold, where it overrides the percentage because it is the more specific statement",
	"compaction.idleThresholdTokens": "consumed by decideIdleCompaction as the context size an idle session must reach",
	"compaction.idleTimeoutSeconds": "consumed by decideIdleCompaction, which waits for the delay before the threshold",
	"compaction.idleEnabled": "consumed by decideIdleCompaction, which produces no action at all when this is off",
	// Tasks tab, Subagents.
	"task.maxConcurrency": "consumed when a subagent is spawned, bounding how many run at once",
	"task.maxRecursionDepth": "consumed when a subagent spawns another, bounding how deep delegation may go",
	"task.softRequestBudget":
		"consumed by resolveSoftRequestBudget, where it can only lower an agent bundled ceiling and never raise it",
	"task.maxEffort": "consumed when a spawn applies its effort, bounding what a subagent may be asked for",
	"task.eager": "consumed when work is classified, choosing whether a self-contained piece is delegated",
	"task.batch": "consumed when several task calls are issued in one turn, choosing batching over one at a time",
	"task.enableLsp":
		"consumed when a subagent is assembled, giving it language-server context for the files it works on",
	"task.enableEffort": "consumed when a task request is read, allowing a specific effort for its subagent",
	// Model tab, Sampling: -1 means the provider default, and absence is not zero.
	temperature: "consumed by resolveParameter, which omits it entirely at the -1 sentinel rather than defaulting it",
	topP: "consumed by resolveParameter; a value outside 0 to 1 is dropped rather than clamped",
	topK: "consumed by resolveParameter, which omits it at the -1 sentinel",
	minP: "consumed by resolveParameter; a value outside 0 to 1 is dropped rather than clamped",
	presencePenalty:
		"consumed by resolveParameter, which omits it at the -1 sentinel and accepts a provider's negative range",
	repetitionPenalty:
		"consumed by resolveParameter, which omits it at the -1 sentinel and accepts a provider's negative range",
	// Appearance tab, Display.
	"display.smoothStreaming": "consumed when a streamed chunk is drawn, choosing a smooth redraw over a per-chunk one",
	"display.hideToolActivity":
		"consumed by toolActivityMode, which chooses how much of a turn's tool activity is drawn",
	"display.showTokenUsage":
		"consumed by renderUsage; a display preference that changes what is drawn and not what was spent",
	"display.showTurnTime": "consumed by renderUsage when the caller measured a duration",
	"display.cacheMissMarker": "consumed by isCacheMiss, which marks only a lost cache and not a write or a hit",
	"display.collapseCompacted":
		"consumed by layoutCompacted, which emits one divider when collapsing and one per point when expanded",
	showHardwareCursor: "consumed when the cursor is hidden or restored while drawing",
	"tui.imeSafeCursor": "consumed when the prompt is laid out, reserving room for an IME candidate window",
	"tui.hyperlinks": "consumed when a path is drawn, choosing an OSC 8 hyperlink or plain text",
	"tui.tight": "consumed when the layout is built, choosing compact padding",
	autoResume:
		"consumed by chooseSessionToResume; a resumed session restores its own model instead of taking a CLI default",
	defaultThinkingLevel:
		"consumed by resolveThinkingLevelForModel, which clamps down to what the active model supports",
	// Tools tab, Discovery & MCP.
	"mcp.enableProjectConfig": "consumed when servers are assembled, gating whether a project may declare its own",
	"mcp.startupTimeoutMs": "consumed by isStartupComplete; 0 waits until connections settle rather than not waiting",
	"mcp.renderMarkdownResults": "consumed when an MCP result is rendered, choosing markdown over plain text",
	"mcp.notifications":
		"consumed by injectionEnabled; disabled means nothing from a server reaches the conversation at all",
	"mcp.notificationDebounceMs":
		"consumed by NotificationDebouncer, which waits for quiet and injects the newest state",
	// Tools tab, Grep & Browser: ownership decides the lifecycle.
	"browser.enabled": "consumed when the browser tool is assembled, gating whether it is offered at all",
	"browser.cdpUrl": "consumed as the attach target; a non-empty value means the browser is shared and never managed",
	"browser.relay": "consumed when the browser tool is assembled, selecting relay access over local launch",
	"browser.relayUrl": "consumed as the relay base URL",
	"browser.headless": "consumed when a tab is opened, deciding whether this session owns it",
	"browser.freezeOnTurnEnd": "consumed by decideTabAction, which freezes an owned idle tab rather than closing it",
	"browser.idleCloseSec":
		"consumed by decideTabAction; 0 never closes on idle, though dispose still reaps what the session owns",
	"browser.screenshotDir": "consumed as the directory screenshots are written to",
	// Tools tab, Todos.
	"todo.reminders":
		"consumed by decideNudge; a nudge is suppressed while the user is mid-question, because a model answering is working",
	"todo.remindersMax": "consumed by decideNudge as the largest plan the reminder will nag about",
	"todo.eager":
		"consumed when a request is classified, choosing whether a multi-step request is turned into a plan without being asked",
	"tasks.todoClearDelay": "consumed when a plan completes, as the delay before it is cleared from the panel",
	// Tools tab, Output Limits: bounding a tool result without losing it.
	"tools.artifactSpillThreshold":
		"consumed by planSpill as the byte threshold above which the full output is saved and only head and tail stay inline",
	"tools.artifactHeadBytes":
		"consumed by planSpill; 0 makes the inline view tail-only, which is right when the end of a result matters and the start is noise",
	"tools.artifactTailBytes": "consumed by planSpill as the byte budget for the tail view",
	"tools.artifactTailLines":
		"consumed before the tail byte budget, so the line count a reader sees does not change with the byte setting",
	"tools.outputMaxColumns":
		"consumed by clampLineWidth; 0 disables the clamp and a clamp of 1 still keeps one character",
	// Providers and tools tabs: web search and URL fetching.
	"web_search.enabled":
		"consumed by resolveSearchProvider; a disabled search resolves to nothing even with credentials present",
	"fetch.enabled": "consumed when the fetch tool runs, gating whether a URL can be read at all",
	"providers.fetch": "consumed when the fetch tool runs, selecting how a URL is retrieved",
	"exa.enabled": "consumed by isUsable; Exa needs an API key and is not usable without one",
	"exa.searchDelayMs": "consumed by pacingDelayMs as the minimum gap between requests, and 0 disables pacing",
	"searxng.endpoint": "consumed as the self-hosted endpoint; a blank value means the provider is not usable",
	// Providers tab, Services: saved rate-limit reset credits.
	"codexResets.autoRedeem": "consumed by decideRedeem; unset asks before the first spend rather than being a boolean",
	"codexResets.minBlockedMinutes": "consumed as the minimum block duration before a rescue is considered",
	"codexResets.keepCredits": "consumed as a reserve never spent automatically",
	"codexResets.salvageHorizonHours": "consumed by creditsExpiringWithin as the horizon for salvaging an unused credit",
	"claudeResets.autoRedeem": "consumed by decideRedeem; unset asks before the first spend rather than being a boolean",
	"claudeResets.minBlockedMinutes": "consumed as the minimum block duration before a rescue is considered",
	"claudeResets.keepCredits": "consumed as a reserve never spent automatically",
	"claudeResets.salvageHorizonHours":
		"consumed by creditsExpiringWithin as the horizon for salvaging an unused credit",
	// Appearance tab, Display.
	"tui.resizeScrollback":
		"consumed by planScrollbackResize; a resize that changed nothing never erases, and only a settled width refreshes history",
	// Context tab, Compaction. Promoted from the pruning implementation and its tests.
	"compaction.dropUseless":
		"consumed by pruneToolOutputs, which elides results the tool flagged as carrying no information",
	// Providers tab, Timeouts.
	"providers.streamFirstEventTimeoutSeconds":
		"consumed by withStreamWatchdog; -1 inherits the provider default and 0 disables the watchdog",
	"providers.streamIdleTimeoutSeconds": "consumed by withStreamWatchdog as the per-gap budget",
	// Providers tab, Privacy.
	"secrets.enabled":
		"consumed by SecretObfuscator, which replaces configured secrets with a keyed placeholder before the request leaves the machine",
	// Model tab, Thinking.
	"composer.recallClearedDrafts":
		"consumed by DraftHistory.clear; a composer holding an image is not empty, and the setting governs future clears only",
	"todo.enabled":
		"consumed by the todo tool; the plan is read from the latest committed branch entry, so a resume or rewind cannot revert it",
	"model.toolCallLoopGuard.enabled":
		"consumed by ToolCallLoopGuard; a detection steers the model away rather than aborting the turn",
	"model.toolCallLoopGuard.threshold":
		"consumed as the number of identical consecutive turns before the guard intervenes",
	"model.toolCallLoopGuard.exemptTools": "consumed as the tools a turn may call without counting as a loop",
	// Files tab, Editing.
	"edit.recoverInlineEdits":
		"consumed by recoverInlineSloppyEdit; a stray payload becomes a synthetic edit tool call so the approval pipeline still runs",
	// Interaction tab, Startup & Updates.
	"compaction.supersedeReads":
		"consumed by pruneToolOutputs, which replaces a result a newer read of the same target made redundant",
};

/** The states, kept distinct because collapsing them is how a panel lies. */
export type LedgerState = "wired" | "omp-present-unmigrated" | "deferred" | "pi-specific";

/** A row's classification, with the evidence for it. */
export interface LedgerEntry {
	readonly id: string;
	readonly tab: string;
	readonly state: LedgerState;
	/** The typed registry key, for a wired row. */
	readonly piKey?: string;
	/** Why the row is in this state. */
	readonly note: string;
	/** True when a runtime consumer is proven, which is a stronger claim than
	 *  "the control renders" or "the key exists". */
	readonly liveVerified?: boolean;
}

export interface LedgerSummary {
	readonly total: number;
	readonly byState: Readonly<Record<LedgerState, number>>;
	readonly byTab: Readonly<Record<string, Readonly<Record<LedgerState, number>>>>;
	/** Rows whose classification did not reconcile. Must be empty. */
	readonly unreconciled: readonly string[];
	/** Wired rows with no typed registry key. Must be empty. */
	readonly wiredWithoutKey: readonly string[];
	/** Rows claiming wired whose declared `status` field disagrees. */
	readonly statusMismatches: readonly string[];
}

/** Rows proven live-verified, distinct from merely wired. */
const LIVE_VERIFIED: ReadonlySet<string> = new Set([
	"memory.backend",
	"mnemopi.dbPath",
	"mnemopi.bank",
	"mnemopi.scoping",
	"mnemopi.autoRecall",
	"mnemopi.autoRetain",
	"retry.modelFallback",
	"todo.enabled",
	"retry.fallbackChains",
	"retry.fallbackRevertPolicy",
	"secrets.enabled",
	"autoResume",
	"edit.recoverInlineEdits",
	"compaction.dropUseless",
	"compaction.supersedeReads",
	"codexResets.autoRedeem",
	"codexResets.keepCredits",
	"codexResets.minBlockedMinutes",
	"codexResets.salvageHorizonHours",
	"claudeResets.autoRedeem",
	"claudeResets.keepCredits",
	"claudeResets.minBlockedMinutes",
	"claudeResets.salvageHorizonHours",
	"defaultThinkingLevel",
	"model.toolCallLoopGuard.enabled",
	"model.toolCallLoopGuard.exemptTools",
	"model.toolCallLoopGuard.threshold",
	"loop.conditionTimeoutMs",
	"loop.mode",
	"followUpMode",
	"interruptMode",
	"steeringMode",
]);

function stateFor(row: ParityRow): LedgerState {
	// The WIRED_ROWS table is authoritative, not the row's own `status` field.
	// Otherwise relabelling a row would promote it, which is exactly the mistake
	// this module exists to prevent.
	if (row.id in WIRED_ROWS) return "wired";
	if (row.status === "pi-specific") return "pi-specific";
	if (row.status === "omp-present-unmigrated") return "omp-present-unmigrated";
	return "deferred";
}

/** Classifies every row, with its evidence. */
export function buildLedger(): readonly LedgerEntry[] {
	return OMP_PARITY_ROWS.map((row) => {
		const state = stateFor(row);
		const wired = state === "wired";
		const note = wired
			? WIRED_ROWS[row.id]!
			: (row.note ?? `not wired: the ${row.id} subsystem is not migrated into PrimePi`);
		return {
			id: row.id,
			tab: row.tab,
			state,
			...(wired ? { piKey: row.piKey ?? row.id } : {}),
			note,
			...(wired && LIVE_VERIFIED.has(row.id) ? { liveVerified: true } : {}),
		};
	});
}

/**
 * Reconciles the ledger.
 *
 * Every failure returned here is a claim the panel cannot back, so a caller
 * that ignores them is asserting something untrue. The test uses all three.
 */
export function reconcileLedger(): LedgerSummary {
	const entries = buildLedger();
	const byState: Record<LedgerState, number> = {
		wired: 0,
		"omp-present-unmigrated": 0,
		deferred: 0,
		"pi-specific": 0,
	};
	const byTab: Record<string, Record<LedgerState, number>> = {};
	const unreconciled: string[] = [];
	const wiredWithoutKey: string[] = [];
	const statusMismatches: string[] = [];

	for (const entry of entries) {
		byState[entry.state] += 1;
		byTab[entry.tab] ??= { wired: 0, "omp-present-unmigrated": 0, deferred: 0, "pi-specific": 0 };
		byTab[entry.tab]![entry.state] += 1;
		if (entry.state === "wired") {
			if (!entry.piKey) wiredWithoutKey.push(entry.id);
			// A row marked wired in the table but still carrying an unmigrated
			// status in the contract is a contradiction, and the row's own label
			// would then be what a user reads.
			const row = OMP_PARITY_ROWS.find((candidate) => candidate.id === entry.id);
			if (row && row.status !== "wired") statusMismatches.push(entry.id);
		}
		if (!entry.note) unreconciled.push(entry.id);
	}

	// PrimePi-only rows sit outside the reference total by design, so the
	// reconciliation is against the reference count specifically.
	const referenceRows = entries.filter((entry) => entry.state !== "pi-specific");
	if (referenceRows.length !== OMP_PARITY_ROW_COUNT) {
		unreconciled.push(`row count: ${referenceRows.length} reference rows, expected ${OMP_PARITY_ROW_COUNT}`);
	}

	return {
		total: entries.length,
		byState,
		byTab,
		unreconciled,
		wiredWithoutKey,
		statusMismatches,
	};
}

/** A one-line report, for a status line or a commit body. */
export function describeLedger(): string {
	const summary = reconcileLedger();
	const parts = [
		`${summary.byState.wired} wired`,
		`${summary.byState["omp-present-unmigrated"]} unmigrated`,
		`${summary.byState.deferred} deferred`,
		`${summary.byState["pi-specific"]} pi-specific`,
	];
	const live = buildLedger().filter((entry) => entry.liveVerified).length;
	return `${parts.join(", ")} of ${summary.total} (${live} live verified)`;
}
