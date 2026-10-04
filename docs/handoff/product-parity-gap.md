# Product-parity gap: the root application shell

**Owner acceptance result: FAIL.** A user who knows current Oh My Pi launches Prime Pi
and sees stock Pi with additional backend machinery. This file records the confirmed
failures and the exact integration points, so work can continue immediately whether or not
Space Bunny reaches retirement.

## Why the earlier evidence was not evidence of parity

The migration ledger, the 383 settings, the 69 runtime-reachable rows and the green backend
suites all measure **individual implementation properties**. None of them observes the
running product. `docs/failure-classification.md` and the evidence ladder are accurate
about what they measure and silent about product parity, which is how the gap stayed
invisible for so long.

## Confirmed failures

| # | Failure | Status |
|---|---|---|
| 1 | Prime Pi launches and operates like stock Pi, not OMP | **open** |
| 2 | Prime Pi branding incomplete | **partially fixed** — prose done; shell identity not audited |
| 3 | OMP themes missing from the running product | **open** |
| 4 | OMP startup/splash missing | **open** |
| 5 | Upstream Pi update leaks as a Prime Pi update (1.0.2, pi.dev/changelog) | **fixed and verified** in `688cce541` |

## The root cause, in one line

**We migrated leaf capabilities without migrating the root application that mounts them.**
`packages/coding-agent/src/modes/interactive/interactive-mode.ts` is still stock Pi's
composition. Everything OMP added sits beside it, reachable through settings, not through
the surface a user actually meets.

## What OMP's root composition is (traced from source, `f3f0260b4` era)

```
process start
  -> cli.ts prepaint block                    beginStartupComposer(): readComposerStartupCache,
                                               initThemeSync(...)  <- built-in dark.json, FIRST PAINT
                                               new Composer(); composer.start({deferInput:true})
  -> main.ts runRootCommand  (~56 ordered steps)
       ensureTheme -> applyStartupCwd -> plugin roots -> settings+auth -> ModelRegistry
       -> catalogs -> initTheme:final (dark -> titanium) -> composer prefs -> LSP
       -> session manager -> OTEL telemetry -> extensions
       -> shouldShowStartupSplash -> createSession -> takeStartupComposerLease()
       -> runInteractiveMode
  -> setup wizard (phase 0 replays the splash art, 420ms dissolve, 5 scenes, 1200ms outro)
```

Key facts, each traced and cited:

- **OMP has no project-trust boundary.** `isProjectTrusted()` is hardcoded `true` at both
  session and runner construction. Prime Pi **added** trust, so OMP's ordering cannot be
  adopted wholesale without giving up a security property.
- **The prepaint theme is trust-independent by construction**: `initThemeSync` runs before
  any settings/auth work and reads only embedded built-ins, never a project path. Prime Pi's
  equivalent path (`startup-ui.ts` `loadStartupThemes`) already passes
  `projectTrusted: false` explicitly, so the property already holds here.
- **The splash defaults off**: `startup.showSplash` default `false`, plus six independent
  conditions in `shouldShowStartupSplash` (`startup-splash.ts:13-21`). The **setup wizard**
  renders the same art as phase 0, which is the default-launch experience.
- **102 registered themes**: `dark.json` + `light.json` + 100 under `theme/defaults/`.
  Contract is **64 required colour tokens** (+ optional `thinkingMax`); values may be
  `#RRGGBB`, a 0-255 palette index, `""`, or a `vars` reference. No `author`/`displayName`.
  Light-vs-dark is decided by `statusLineBg` luma > 0.5, not a flag. Auto-detection is
  OSC 11 -> COLORFGBG -> macOS-under-Zellij -> dark.
- **Prime Pi has no `setRegisteredThemes`.** OMP's registry API does not exist here, so a
  direct port needs that seam created.

## Integration points, in dependency order

| order | work | Prime Pi touch points | OMP reference |
|---|---|---|---|
| 1 | theme contract + registry | `src/modes/interactive/theme/theme.ts`, `theme/colorblind.ts` | `packages/tui/src/theme/{schema,loader,theme,theme-class,color}.ts` |
| 2 | built-in + 100 default themes | new `theme/defaults/` beside the above | `packages/tui/src/theme/defaults/index.ts`, `theme/defaults/*.json` |
| 3 | `setRegisteredThemes` seam | `startup-ui.ts` calls `setRegisteredThemes` — **verify the symbol resolves after the port** | `loader.ts:18-22` `BUILTIN_THEMES` |
| 4 | settings-driven selection + persistence | must flow through the **typed settings registry**, never a second authority | `main.ts:1835` `initTheme:final` |
| 5 | startup composer prepaint | `cli`/`main` startup path; must stay trust-independent | `modes/startup-composer.ts:71-112` |
| 6 | splash + setup wizard | run from the real launch path, gated as OMP gates it | `tui/src/setup/{wizard,wizard-overlay,startup-splash}.ts`, `scenes/splash.ts` |
| 7 | shell composition | `interactive-mode.ts` — the primary target | `main.ts#runInteractiveMode:573-749` |
| 8 | hard-coded colour audit | every component bypassing `theme` | — |

## Constraints that must survive the port

Prime Pi's stronger authorities are **not** to be reverted:

- typed settings registry (theme selection must flow through it)
- model eligibility / `policyAllowsPaid` / `selectFailoverCandidate`
- approval and security authority, self-update barrier
- memory architecture, Windows transport, persistence fixes
- evidence and reachability machinery

OMP-derived presentation **proposes and integrates**; Prime Pi authorities stay
authoritative.

## Rule for claiming parity

**Never from source inspection or tests.** A surface is parity-complete only when it is
reachable and observable in the **running built application**, compared against the
**running OMP**. That is the standard the earlier ledger work did not meet.
