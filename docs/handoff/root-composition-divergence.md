# Root composition divergence: Prime Pi mounts stock Pi's UI, not OMP's

**Status: reported for owner direction. No implementation attempted yet.**

The migration so far added OMP *capabilities* beside stock Pi's *composition*. The owner ran
the shipped binary and confirmed the result: major surfaces, Settings included, render as Pi.
This file records where that happens, mechanically, so the correction targets the composition
rather than another surface.

## The finding

OMP's interactive mode is **one 8243-line file** that owns its own UI tree:

    oh-my-pi/packages/coding-agent/src/modes/interactive-mode.ts      8243 lines
    oh-my-pi/packages/coding-agent/src/modes/controllers/              selector-controller.ts
    oh-my-pi/packages/coding-agent/src/modes/components/

It composes 70 imports from `@oh-my-pi/pi-tui`, including surfaces Prime Pi does not have:

    @oh-my-pi/pi-tui/native/describe        declarative native node tree
    @oh-my-pi/pi-tui/native/memo            memoisation
    @oh-my-pi/pi-tui/chrome/segment-track   chrome composition
    @oh-my-pi/pi-tui/overlays/model-selector

Prime Pi's interactive mode is **a directory** that mounts stock Pi components:

    pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts
    pi/packages/coding-agent/src/modes/interactive/components/

## Missing TUI surface, counted

| OMP `packages/tui/src/` | files | Prime Pi |
|---|---|---|
| `apps/` | 25 | **0** |
| `chrome/` | 28 | **0** |
| `native/` | 15 | **0** |
| `render/` | 14 | **0** |
| `setup/` | 13 | **0** |
| `tools/` | 62 | **0** |

Plus these modules, absent from Prime Pi entirely: `app-keybindings.ts`, `key-hint-format.ts`,
`symbols.ts`, `glyph-protocol.ts`, `mouse.ts`, `ttyid.ts`, `vim.ts`, `tmux.ts`,
`terminal-capabilities.ts`, `bracketed-paste`.

## Settings, traced to the mount

| | OMP | Prime Pi |
|---|---|---|
| Renderer | `pi-tui/overlays/settings-selector.ts` (1975 lines) | `modes/interactive/components/settings-selector.ts` (664 lines) |
| Mounted by | `modes/controllers/selector-controller.ts:270` | `interactive-mode.ts:4882` |
| Structure | tab bar, `#switchToTab`, per-tab trees, search | flat registry rows, no tabs |
| Provenance | OMP-authored | Pi upstream (`b483a8100`), values wired in |

OMP mounts `SettingsSelectorComponent` with a settings host, a plugin host, a theme preview
callback and an `imageBudget`, on the alternate screen with mouse tracking:

    const selector = new SettingsSelectorComponent(
      { availableThinkingLevels, thinkingLevel, availableThemes, providers,
        settings: createSettingsHost(), plugins: createPluginSettingsHost(getProjectDir()),
        model, imageBudget, requestRender, composerPreviewStatus },
      { onChange, onThemePreview, ... });

Prime Pi mounts its own class, derived from stock Pi's, with no tab structure.

There is also `packages/tui/src/overlays/settings-panel.ts` (638 lines) in the Prime Pi tree.
**Nothing mounts it.** It is unreferenced scaffolding, which is why its presence in earlier
audits was misleading.

## Live evidence from the shipped binary

While adding the five-scene wizard, the same defect showed up in a second surface and is worth
recording because it is the same mistake:

The wizard mounted correctly, received keystrokes correctly, and advanced scene to scene:

    [wizard] key="\r"              scene=providers
    [wizard] key="\u001b[B"        scene=model

and then was painted over by the interface that had already been mounted beneath it:

    t=1s  wizard=False main=False
    t=2s  wizard=False main=True     <- stock Pi frame, and it stays

The wizard's scenes are OMP-shaped and version-gated. The frame they render inside is stock
Pi's. That is the divergence in one picture: **the correct surface, mounted in the wrong
composition, losing to the composition that got there first.**

## Why earlier verification missed it

The parity work measured implementation properties - 383 settings registered, 102 themes
applied, 69 runtime-reachable rows, green suites. Every one of those is true of stock Pi's
composition too. `docs/handoff/product-parity-gap.md` already concluded this
("SOURCE EXISTS != MIGRATED"), and the settings-panel finding is a concrete instance: a real
file, in the right package, matching the right name, mounted by nothing.

## Required correction

Replace the mount points, not the surfaces. For each major surface:

    OMP renderer -> OMP mounting point -> Prime Pi current renderer -> divergence -> required integration

Prime Pi's stronger internal authorities stay authoritative behind the OMP-derived surface:
model eligibility / `policyAllowsPaid` / `selectFailoverCandidate`, the credential and spending
guards, project trust, the self-update barrier, provenance-preserving context edits, the typed
settings registry, and the build/dependency integrity gates.

The ordering that follows from the dependency graph: OMP's `native/` describe/memo layer and
`chrome/` are what its overlays are built from, so they come before any overlay can be ported
without being re-plumbed. `app-keybindings.ts` and `key-hint-format.ts` come next, because
every OMP surface renders its hints through them.