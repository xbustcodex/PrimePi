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
| 1 | Prime Pi launches and operates like stock Pi | **partly closed** — launch path corrected; composition still stock |
| 2 | Prime Pi branding incomplete | **closed for prose** (`product-branding.test.ts`), shell identity still to audit |
| 3 | OMP themes missing from the running product | **closed** — 102/102 applied and **selection verified** (`46359ce7a`) |
| 4 | OMP startup/splash missing | **closed** — rendered by the shipped binary (`5c5955905`, `b1f8bbbac`) |
| 5 | Upstream Pi update leaks as a Prime Pi update | **closed and verified** (`688cce541`) |
| 6 | First-run onboarding unreachable | **closed** (`4314b93f7`) — on by default, skippable |

### Verified by running the built application

Captured from the shipped binary at 120x34, not from source:

- **Theme inventory:** 102 themes, every one loads and applies (`theme-inventory.test.ts`).
  Two of them needed a colour-parser fix — 70 of the 102 use `#RRGGBBAA`.
- **Startup splash:** starfield, 2x brand mark in the diagonal gradient, and the rippling
  water surface all appear at ~2s in a real launch. The skip hint has not yet been
  confirmed visually.

## Failures found by running the application, after the ledger said "done"

These are not in the original table because they were invisible to it. Each was found by
launching the shipped binary, not by reading code.

| Failure | Fix |
|---|---|
| The splash **never cleared** - `timer.unref()` let the event loop exit mid-animation, leaving a visibly stuck terminal | `5c5955905` |
| `theme.dark` / `theme.light` were declared in the registry but **never read**; the runtime read a flat `theme` key, so configuring a slot did nothing | `46359ce7a` |
| Both theme defaults named themes that **were never registered** (`primepi-dark`), so an unconfigured lookup failed silently | `46359ce7a` |
| First-run onboarding was gated behind `PI_EXPERIMENTAL=1`, so a fresh install got an empty prompt | `4314b93f7` |
| The splash ran on **every** launch; the reference defaults it off because there it is the wizard's first scene | `b1f8bbbac` |

Two of these were introduced by the migration work itself (the unref, the gate), which is
the argument for the running-application standard: none of them failed a test.

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
| 3 | 5-scene first-run setup wizard - **reachable now**, scenes still to port | new `modes/interactive/setup/` | `tui/src/setup/{wizard,wizard-overlay}.ts` |
| 4 | theme selector reachable from the UI, with live preview | settings `appearance` tab | `main.ts:1835`, `previewTheme` |
| 5 | shell composition | `interactive-mode.ts` — the primary target | `main.ts#runInteractiveMode:573-749` |
| 6 | hard-coded colour audit | **closed** — no user-visible violation; see below | — |

## Hard-coded colour audit: closed

Every hard-coded colour outside the theme system was traced to its call sites:

| Site | Verdict |
|---|---|
| `theme/theme.ts:266,328` | Default-foreground resets (`\x1b[39m`/`49m`). Correct as-is. |
| `tui/colors.ts:367` | Default-foreground reset. Correct as-is. |
| `tui/components/scroll-view.ts:53-54` | Fixed ANSI 90/37, but `scrollbar` defaults to `hidden`, so the styles are unreachable unless a caller opts in. Every caller that does opt in supplies themed styles - `interactive-mode.ts:938-939` and `experimental/client-tui.ts:149-150`. |
| `export-html/ansi-to-html.ts:16-31` | The 16 standard ANSI colours. Required: that table *is* the mapping from ANSI codes. |
| `export-html/index.ts:120,154` | `#343541` is a documented fallback, consulted only when the theme has no value for `userMessageBg`. |

No component bypasses the theme on a path a user can reach.

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
