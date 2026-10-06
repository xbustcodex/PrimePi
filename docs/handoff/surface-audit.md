# Surface audit: what Prime Pi still renders with stock Pi's code

Written after the Settings mount, from the mounts themselves rather than from what exists in
either source tree.

**The rule this applies:** an OMP surface present in source is not parity. It is parity when the
shipped Prime Pi executes it. Two failure modes look identical from a file listing and are
different problems:

- **never ported** - Prime Pi has no equivalent, so a stock Pi surface is all there is
- **ported but unmounted** - the OMP renderer exists and compiles, and something else is mounted
  in its place. These are worse: they look done.

## Verified mounted through the OMP surface

| Surface | Mount | Authority behind it |
|---|---|---|
| Settings | `interactive-mode.ts:4894` `showSettingsSelector` | `SettingsManager` via `createSettingsHost` |

## Ported, compiling, not mounted

| OMP surface | Prime Pi status | What mounts instead |
|---|---|---|
| `overlays/plugin-settings.ts` | compiled, gated off | nothing - Prime Pi has no plugin or marketplace manager |
| `overlays/theme-selector.ts` | compiled | unused; Settings previews through the theme controller |
| `overlays/composer-shape-preview.ts` | compiled | unused; the composer frame has no preview |
| `overlays/settings-panel.ts` | **Prime Pi's own, unmounted** | `settings-selector.ts` now is |

`settings-panel.ts` is worth calling out: 638 lines written as a Settings surface, with a
`SettingsHost` interface whose `unset` nothing implemented, mounted by nothing. It was the thing
that made Settings *look* migrated during the earlier audit.

## Replaced by a stock Pi surface

Every row below is a place where Prime Pi's app mounts Pi's component where OMP mounts its own.
The right-hand column is OMP's renderer for the same job.

| Job | Prime Pi mounts | OMP mounts |
|---|---|---|
| Model picker | `ModelSelectorComponent` (Pi) | `model-selector`, `model-picker`, `model-hub` |
| Session picker | `SessionSelectorComponent` (Pi) | `session-selector`, `session-info-overlay` |
| Extension picker | `ExtensionSelectorComponent` (Pi) | `plugin-selector` |
| Scoped models | `ScopedModelsSelectorComponent` (Pi) | `model-hub` |
| Login / OAuth | `LoginDialogComponent`, `OAuthSelectorComponent` (Pi) | `login-dialog`, `oauth-selector` |
| User message picker | `UserMessageSelectorComponent` (Pi) | `rewind-selector`, `copy-selector` |
| Project trust | `TrustSelectorComponent` (Pi) | *none* - OMP hardcodes trusted |
| Nothing | - | `ask-dialog`, `error-banner`, `hook-editor`, `jobs-panel`, `plan-review-overlay`, `thinking-selector`, `tree-selector`, `usage-dashboard`, `agent-hub`, `agents-hub` and others |

The last row is the size of the remaining work: OMP mounts 45 overlays from its interactive mode,
Prime Pi mounts 8 selector components. Some of that is deliberate - Prime Pi's project trust is
an authority OMP does not have and must not lose - and some of it is simply unmigrated.

## The trust boundary is the one place the numbers invert

Prime Pi has `TrustSelectorComponent` and OMP has no equivalent, because
`isProjectTrusted()` is hardcoded `true` in the reference. That is Prime Pi's stronger authority
and it stays. It is also the clearest example of the rule for the rest of this work: where OMP
replaces a Pi surface, adopt OMP's renderer *behind* Prime Pi's authority rather than adopting it
wholesale.

## Found by using OMP, not by reading it

The composition work was being done *inside* OMP, which made three more instances of the same
defect directly observable: every tool call I made renders OMP's tool card, and the composer and
status line are on screen at all times. Comparing what I could see against PrimePi's equivalents
found these faster than any amount of source reading.

### Tool cards: OMP has a bordered, state-toned card; Prime Pi has plain text

OMP (`render/tool-card.ts`, 409 lines) describes every tool call as `role: "omp.tool"` with a
tone derived from `borderColor`, a title span, a `meta` line, `sections`, and an `inset` for the
plain variant. The card's border colour *is* the state indicator.

PrimePi's `tool-execution.ts` (433 lines) builds `new Text(theme.fg("toolTitle", ...))` and
`new Text(theme.fg("toolOutput", ...))`. No card, no border, no tone, no state encoding.
`grep` for `DynamicBorder`, `borderColor` and `card(` in it returns nothing.

**User-visible:** running a command in PrimePi and in OMP produces visibly different transcript
rows - OMP frames each tool result and marks running/succeeded/failed by border colour, PrimePi
prints unframed lines with no state distinction.

### The composer: 11 files ported, referenced by nothing

`components/composer/` (band, borderless, box, claude, field, pi, rail, rule, registry, types)
is reachable only from `packages/tui/src/index.ts`. `editor.ts` has **zero** references to
`getComposerStyle` or the registry. So `composer.shape` selects a shape that nothing applies -
the same "declared but never read" shape as the model roles, one level deeper and more visible,
because the composer is the surface in front of the user at all times.

### The status line: presets ported, footer does not read them

`status-line/presets.ts` and `schema.ts` exist; `footer.ts` and `footer-data-provider.ts` have
**zero** references to `getPreset` or `STATUS_LINE_PRESETS`. The footer takes its data from
`footer-data-provider` and renders Pi's own arrangement, so the preset Settings exposes and the
status-line preview in Settings previews have no effect on what is drawn.

## Next, in descending user impact

### 1. Model roles have an authority and no surface

`SettingsManager.getModelRoles` / `setModelRole` were ported in Phase 1 and work: roles persist to
`modelRoles` in `settings.json` and `AgentSession` reads them at four sites. **Nothing writes
them.** The mounted model picker has no role surface at all - zero occurrences of `role` in
`model-selector.ts` - where OMP's `model-browser` takes a `SessionModelScope` carrying
`roles: RoleAssignments` and renders them.

So a user can configure a role by hand-editing `settings.json`, and the runtime honours it, and
the application never offers it. That is the "declared but never reachable" shape, and it is the
single largest user-visible gap found by this audit.

    settings.setModelRole("smol", "openai/gpt-4o-mini")
    -> { "modelRoles": { "smol": "openai/gpt-4o-mini" } }
    -> AgentSession honours it
    -> no UI writes it

### 2. The model picker, once roles are in it

OMP: `model-picker.ts` (477) over `model-browser.ts` (2015) over `model-hub.ts` (3964).
Prime Pi: `model-selector.ts` (453), session-scoped, no roles. Porting the browser chain is
roughly 6000 lines and the roles work is what makes it worth doing.

### 3. Session picker and session info

OMP has `session-selector` and `session-info-overlay`; Prime Pi mounts its own
`SessionSelectorComponent`.

### 4. Smaller, and cheaper

`thinking-selector`, `tree-selector`, `copy-selector`, `hook-editor`, `error-banner`,
`ask-dialog`, `plan-review-overlay`, `jobs-panel`, `usage-dashboard`.

## What is not established here

No visual comparison. This is a mount inventory read from the call sites; whether a given
replacement matches the reference closely enough is an acceptance question, not something this
file can answer.