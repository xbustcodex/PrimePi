# Product-parity gap: the root application shell

**Owner acceptance result: FAIL.** A user who knows current Oh My Pi launches Prime Pi
and sees stock Pi with additional backend machinery. This file records the confirmed
failures and the exact integration points, so work can continue immediately.

## Why the earlier evidence was not evidence of parity

The migration ledger, the 383 settings, the 69 runtime-reachable rows and the green backend
suites all measure **individual implementation properties**. None of them observes the
running product. `docs/failure-classification.md` and the evidence ladder are accurate
about what they measure and silent about product parity, which is how the gap stayed
invisible for so long.

## The root cause, in one line

**We migrated leaf capabilities without migrating the root application that mounts them.**
`packages/coding-agent/src/modes/interactive/interactive-mode.ts` is still stock Pi's
composition. Everything OMP added sits beside it, reachable through settings, not through
the surface a user actually meets.

Confirmed at the module level - the reference has whole directories this tree lacks:

| OMP `packages/tui/src/` | Prime Pi `packages/tui/src/` |
|---|---|
| `setup/` (splash, wizard, scenes) | **absent** |
| `native/` (describe, memo, node) | **absent** |
| `chrome/` | **absent** |
| `app-keybindings.ts`, `key-hint-format.ts` | **absent** |
| `prompt/welcome.ts` (holds `PI_LOGO`) | `prompt/` has only `draft-history.ts` |

## Status

| # | Failure | Status |
|---|---|---|
| 1 | Prime Pi launches and operates like stock Pi | **partly closed** — splash now on the launch path; composition still stock |
| 2 | Prime Pi branding incomplete | **closed for prose** (`product-branding.test.ts`), shell identity still to audit |
| 3 | OMP themes missing from the running product | **inventory complete** (102/102 applied); reachability from the UI still to verify |
| 4 | OMP startup/splash missing | **closed** — rendered by the shipped binary, captured |
| 5 | Upstream Pi update leaks as a Prime Pi update | **closed and verified** (`688cce541`) |

### Verified by running the built application

Captured from the shipped binary at 120x34, not from source:

- **Theme inventory:** 102 themes, every one loads and applies (`theme-inventory.test.ts`).
  Two of them needed a colour-parser fix — 70 of the 102 use `#RRGGBBAA`.
- **Startup splash:** starfield, 2x brand mark in the diagonal gradient, and the rippling
  water surface all appear at ~2s in a real launch. The skip hint has not yet been
  confirmed visually.

## What OMP's root composition is (traced from source)

```
process start
  -> cli.ts prepaint block       beginStartupComposer(): readComposerStartupCache,
                                  initThemeSync(...)  <- built-in dark.json, FIRST PAINT
                                  new Composer(); composer.start({deferInput:true})
  -> main.ts runRootCommand (~56 ordered steps)
       ensureTheme -> applyStartupCwd -> plugin roots -> settings+auth -> ModelRegistry
       -> catalogs -> initTheme:final (dark -> titanium) -> composer prefs -> LSP
       -> session manager -> OTEL -> extensions
       -> shouldShowStartupSplash -> createSession -> takeStartupComposerLease()
       -> runInteractiveMode
  -> setup wizard (phase 0 replays the splash art, 420ms dissolve, 5 scenes, 1200ms outro)
```

Key facts, each traced and cited:

- **OMP has no project-trust boundary.** `isProjectTrusted()` is hardcoded `true`. Prime Pi
  *added* trust, so OMP's ordering cannot be adopted wholesale.
- **The prepaint theme is trust-independent by construction** — `initThemeSync` reads only
  embedded built-ins. Prime Pi's equivalent already passes `projectTrusted: false`.
- **The splash defaults off** in OMP (`showSplash` default `false`, six gating conditions).
  The default-launch experience is the setup wizard, whose phase 0 *is* the splash art.
- **`assets/lspv.webp` is documentation only.** The sole reference is
  `README.md:143`; no code loads it, and the splash is drawn from terminal characters.

## Remaining integration points

| order | work | Prime Pi touch points | OMP reference |
|---|---|---|---|
| 1 | splash visual completeness (skip hint, compact fallback) | `modes/interactive/startup-splash.ts` | `tui/src/setup/scenes/splash.ts` |
| 2 | startup composer prepaint, so there is no unthemed flash | `cli`/`main` startup path | `modes/startup-composer.ts:71-112` |
| 3 | 5-scene first-run setup wizard | new `modes/interactive/setup/` | `tui/src/setup/{wizard,wizard-overlay}.ts` |
| 4 | theme selector reachable from the UI, with live preview | settings `appearance` tab | `main.ts:1835`, `previewTheme` |
| 5 | shell composition | `interactive-mode.ts` — the primary target | `main.ts#runInteractiveMode:573-749` |
| 6 | hard-coded colour audit | every component bypassing `theme` | — |

## Constraints that must survive

Prime Pi's stronger authorities are **not** to be reverted: the typed settings registry
(theme selection must flow through it), model eligibility / `policyAllowsPaid` /
`selectFailoverCandidate`, the approval and security authority, the self-update barrier,
the memory architecture, the Windows transport, persistence fixes, and the
evidence/reachability machinery.

OMP-derived presentation **proposes and integrates**; Prime Pi authorities stay
authoritative.

## Rule for claiming parity

**Never from source inspection or tests.** A surface is parity-complete only when it is
reachable and observable in the **running built application**, compared against the
**running OMP**. That is the standard the earlier ledger work did not meet.
