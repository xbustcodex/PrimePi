# OMP → PrimePi migration: dependency graph and phase plan

> **Scope, corrected 2026-09-28.** This is not merely an API-layer migration.
> The objective is migrating OMP's useful *capability layer, behavior and
> user-facing functionality* into PrimePi while preserving PrimePi's stronger
> architecture and authorities - ModelAccess/isCredentialFree,
> policyAllowsPaid, selectFailoverCandidate, hierarchical failure scopes,
> provenance-preserving context edits, project trust, the self-update barrier,
> build/dependency integrity gates, and the typed settings registry.
> The API surface below is the dependency order, not the destination.

Source of truth: `oh-my-pi` (read-only) at `C:\Users\xkali\new_ai\oh-my-pi`.
Target: this fork.

Scope is **the whole useful OMP capability surface**, ordered by dependency — not a
feature-by-feature worthiness judgement. Excluded: automatic self-update paths,
untrusted project discovery, destructive rewind semantics, and the cancelled
local-model/Ollama workstream.

## 0. Preserved authorities (never re-derived by ported code)

| Authority | Pi home | Rule for ported code |
|---|---|---|
| `ModelAccess` / `isCredentialFree` | `packages/ai/src/types.ts`, `utils/free-model.ts` | classify; never infer paid/free from provider identity |
| `policyAllowsPaid` | `packages/ai/src/utils/failover.ts` | sole paid-spending gate |
| `selectFailoverCandidate` | same | final eligibility gate for *every* model hop |
| failure scopes / cooldowns | `utils/availability.ts`, `utils/availability-cooldowns.ts` | `FailureScope` = model/route/funding-pool/provider |
| provenance-preserving context edits | `core/session-manager.ts` | branch, never delete |
| project trust | `core/settings-manager.ts` | project layer unread/unwritable when untrusted |
| self-update barrier | `utils/self-update-barrier.ts` | env opt-in only |
| build/dependency integrity gates | root `check` script | stay wired |
| typed settings registry | `core/settings-registry.ts` | settings declare through it, not ad hoc |

**The single architectural rule:** ported subsystems *propose* models; they never
*select* them. Anything resolving a model ends in `selectFailoverCandidate`.

## 1. Migration layers

```
L0  Foundations (DONE)
    typed settings registry · ModelAccess · failover/cooldowns · smol role

L1  Resolution spine            <- next phase
    role grammar + expansion · settings notification · model controls
        │
L2  Selection & registry
    provider/model discovery · registry availability · fallback chains
        │
L3  Capability substrates        <- all depend on L1+L2
    context/session · tools · task/subagent · memory SPI · planning/advisor
        │
L4  Integrations
    LSP · DAP · browser/computer · Git · GitHub
        │
L5  Composition
    commands · skills · extension hooks · settings UI
```

## 2. Per-capability migration table

Legend — **P** port · **A** adapt · **N** new.

### L1 — Resolution spine

| OMP API | Pi equivalent | | Dependencies | Invariant conflict | Tests |
|---|---|---|---|---|---|
| `config/registry.ts` `register()` + `Setting` handle | `core/settings-registry.ts` `registerSetting` | **A** | — | none; Pi's `SettingSource` is 4-layer vs OMP 6 (`env` is a default fallback, not an override — deliberate) | declaration/parse/round-trip; existing `settings-registry.test.ts` |
| `SettingEnv` env precedence | Pi `parseEnv` | **A** | registry | OMP lets env outrank every layer; keep Pi's fallback-only semantics | env does not override explicit config |
| `Settings.onEffectiveChange` | `getRevision()` polling only | **N** | registry | none — pure addition | listener fires once per coalesced change; unsubscribes cleanly |
| `Setting.listen` / `Derived` memo | none | **N** | notification | none | recompute is identity-stable |
| `model-roles.ts` `MODEL_ROLES` + alias grammar | `packages/ai/src/utils/model-roles.ts` | **P** (done) | registry | `isCredentialFree`, `policyAllowsPaid` | `model-roles.test.ts` (30) |
| `resolveConfiguredRolePattern` recursion + cycle guard | `expandRolePatterns` | **P** (done) | roles | none | self-reference, cycle, depth bound |
| `resolveRoleChain` (ordered chain, explicit-flag upgrade, routing-aware dedup) | `resolveRoleCandidates` (candidate list only) | **A** | roles, `selectFailoverCandidate` | **chain must not bypass the failover gate** | paid-free order; dedup; cooldown exclusion |
| `getModelMatchPreferences` (usage MRU, provider order) | none | **N** | registry, settings | none — ranking only, cannot widen eligibility | preference precedence order |
| `matchModel` 7-phase matcher | `matchesPattern` (2-phase) | **A** | catalog | none | exact provider/id before bare id; provider-locked cross-match refusal |
| `splitThinkingSuffix` / `formatModelSelectorValue` | Pi `ThinkingLevel` + `thinkingLevelMap` | **A** | roles | none | `@smol:high` round-trip; `auto` not a `ThinkingLevel` |
| `cfgDisabledProviders` / `cfgEnabledModels` / `cfgModelProviderOrder` / `cfgCycleOrder` / `cfgModelTags` | `core/settings-registry.ts` descriptors | **A** | registry | disabled provider must be filtered *before* role resolution | disabled provider never appears in candidates |
| `priority.json` built-in chains | `SMOL_CHAIN`/`SLOW_CHAIN`/… | **P** (done) | roles | local-model dictation chain dropped | chain entries that match nothing yield no candidates |

### L2 — Selection & registry

| OMP API | Pi equivalent | | Dependencies | Invariant conflict | Tests |
|---|---|---|---|---|---|
| `ModelRegistry` (~45 methods) | `core/model-runtime.ts` + `ai/models-store.ts` | **A** | L1 | registry must never be a credential bypass | `getAvailable` excludes disabled + uncredentialed |
| `getAvailable` availability predicate | `model-runtime` snapshot | **A** | `ModelAccess` | anonymous ≠ free; `isAnonymouslyAccessible` | anonymous model needs no key; keyed model does |
| `hasConfiguredAuth` / `hasConcreteAuth` | `modelRuntime.hasConfiguredAuth` | **P** | registry | ambient AWS/Vertex creds must not outrank a signed-in provider | sole-credentialed provider still selected |
| catalog build + `models.db` SQLite cache | `ai/model-catalog.ts` | **A** | registry | request headers never persisted | cache round-trip; no header leakage |
| `retry-fallback-chains.ts` | Pi failover policy | **N** | L1, cooldowns | **must reuse `selectFailoverCandidate`, not a parallel selector** | chain candidate still clears every gate |
| `compat/collapse` variant aliases | none | **N** | catalog | none | retired variant alias resolves |

### L3 — Capability substrates

| OMP API | Pi equivalent | | Dependencies | Invariant conflict | Tests |
|---|---|---|---|---|---|
| `SessionManager` journal + tree | `core/session-manager.ts` JSONL tree | **P** (mostly present) | — | branch-not-delete is already ours | existing session tests |
| `discardEntryDurably` | absent | **N** | session | must keep a `branch_summary` marker | abandoned subtree survives on disk |
| rewind (`checkpoint`/`rewind`) | absent | **EXCLUDE** | — | destructive rewind semantics | — |
| `AgentTool` contract (Arktype) | `core/extensions/types.ts` `ToolDefinition` (TypeBox) | **A** | L1 | none | param validation round-trip |
| `validateToolArguments` quirk passes | absent | **N** | tools | none | double-encoded key, flattened array, optional-null |
| 30 built-in tools | 8 (`read, bash, powershell, edit, write, grep, find, ls`) | **N** (22 to add) | L3 tools | none | each tool's own contract |
| approval tiers `read/write/exec` | absent | **N** | tools | fail-closed; subagents run `yolo` under parent authorisation | deny wins; mode tier cap |
| `TaskTool` / `runSubprocess` | absent | **N** | L1 roles, tools | subagent model **must** resolve through roles → failover | role selection order; depth cap; concurrency |
| `MemoryBackend` SPI | absent | **N** | L3 | redact must be non-linear and total | redaction idempotence; backend degradation |
| plan-mode | absent | **N** | L1 roles | plan file is a markdown artifact, not context | plan survives compaction prune |
| advisor loop | absent | **N** | L1 roles, tools | advisor resolves `advisor` role; never inherits primary silently | `no_model` status path |

### L4 — Integrations

| OMP API | Pi equivalent | | Dependencies | Invariant conflict | Tests |
|---|---|---|---|---|---|
| LSP client + writethrough + mux | **absent entirely** | **N** | L3 tools | none | diagnostics-after-write; server config merge |
| DAP client + adapters | **absent entirely** | **N** | L3 tools | none | attach/launch adapter resolution |
| browser/computer (Puppeteer/CDP) | absent | **N** | L3 tools | none | tab acquire/release; aria snapshot |
| Git via `@oh-my-pi/pi-natives/vcs` (Rust) | Pi uses `git` CLI | **A** | — | shell-out is the boring, portable choice | status/diff/commit against a real repo |
| GitHub via `gh` CLI | absent | **N** | L3 tools | none | `github.available()` gate when `gh` missing |

### L5 — Composition

| OMP API | Pi equivalent | | Dependencies | Invariant conflict | Tests |
|---|---|---|---|---|---|
| 37 extension hooks | 35 `ExtensionAPI.on` hooks | **A** | L1 | OMP hooks are denied `switchSession`/`compact` to prevent deadlock — keep that denial | hook denial preserved |
| `slash-commands` data registry | `registerCommand` | **A** | L5 hooks | none | aggregation across sources |
| skills (`SKILL.md` + discovery) | absent | **N** | L1 settings | none | discovery + `skill:` invocation |
| skillshare distribution | absent | **N** | skills | **script-bearing versions need explicit confirmation** | integrity check; script prompt |
| `extensions/model-api.ts` `resolve(spec)` | `resolveRoleCandidates` | **A** | L1 | read-only; must not expose registry mutation | `@slow` alias resolves to a base model |

## 3. Critical findings

1. **Pi has no LSP and no DAP.** The whole `src/lsp` and `src/dap` trees are new work.
   Both are self-contained protocol clients, so they can land on the L3 tool spine
   without disturbing anything above.
2. **Pi's settings lack push notification** (`getRevision()` polling only). OMP's
   `Derived.listen` is a memoised change stream. Every L2+ subsystem wants it, so it
   belongs at the top of the next phase.
3. **OMP's resolver has no paid/free filter of its own.** Payment tier enters only via
   credential presence. Pi's `policyAllowsPaid` is strictly stronger and must stay the
   gate — the port's `resolveRoleCandidates` correctly defers to it.
4. **OMP's context provenance is thin**: `MessageAttribution` is billing-only, and the
   only lineage record is `BranchSummaryEntry`. Pi's branch-not-delete model already
   exceeds it. There is no per-message origin chain to port.
5. **Git is a native Rust addon in OMP, a `git` CLI shell-out in Pi.** Port the CLI
   approach; do not introduce a native VCS addon.
6. **OMP's `advisor` is a full watch loop** (`WATCHDOG.yml`, transcript recorder,
   emission guard, quota accounting). It is a large subsystem, not a role binding.
7. **Subagent models arrive as a role alias, never a raw model.** OMP carries
   `modelOverride` (expanded) + `modelRole` (alias) so the child keeps role-keyed
   fallback. Pi's `_resolveRoleModelForSummarization` already follows this shape.

## 4. Next implementation phase (Phase 2) — exact scope

**Goal: complete the resolution spine so L2+ has something to build on.**

Included:
1. `SettingsManager.onEffectiveChange` — a change-notification emitter alongside the
   existing `getRevision()`. Coalesced, unsubscribe-safe, revision-bumped.
2. Settings descriptors for model controls: `disabledProviders`, `enabledModels`,
   `modelProviderOrder`, `modelRoleStorage` — declared through the typed registry, so
   they inherit project-trust gating for free.
3. `resolveRoleChain` on top of the existing `resolveRoleCandidates`: ordered
   candidates, routing-aware dedup, explicit-config upgrade, and
   `retry.fallbackChains` read through the registry. **Every candidate still passes
   `selectFailoverCandidate` before use.**
4. `getModelMatchPreferences` — usage-MRU and provider-order ranking, applied strictly
   *after* eligibility, never as a substitute for it.
5. Role-think-suffix grammar (`@smol:high`) on top of the existing alias parser.

Explicitly out of scope for this phase: LSP, DAP, browser, Git, GitHub, subagents,
memory, skills, advisor. Those are L3/L4 and depend on this spine.

Gates: typecheck clean, biome clean, and new tests covering
{notification coalescing, disabled-provider exclusion, chain ordering under
free-only, preference ranking not widening eligibility, think-suffix round-trip}.
