# Observed: current OMP, running

Captured from the **real installed binary**, not the source tree and not documentation.

    C:\Users\xkali\AppData\Local\omp\omp.exe    omp/18.3.2

Launched in a real console (mintty, 120x34) with an isolated HOME, so this is the genuine
first-run experience.

## What OMP actually presents on first launch

```
        ✦       ·             ✦         ✦           ✦ ████████████
          ✧      ✦     ✦           ✦  ✧       ✧          ██  ██
                     ·    · ✦  ✧   ✦     ✧·              ██  ██
                                           ✦             ▒▒  ██
        ✧              ✧✦ ✦✧            ✦       ███████████████
    ✦✧              ✧ ✧✦      ·  ✦        ✧     ██████████omp
        ✧    ·            ✦   ✦                 ██·Setup step 1 of 5

    Set up your providers
    Sign in and pick a web search provider. Press Esc when you're done.

    Providers:   Sign in    Web search   (tab to cycle)

    ╭─ Select provider to login ─────────────────────────────────────────╮
    │ ❯ ChatGPT Plus/Pro (Codex Subscription)                            │
    │   Anthropic (Claude Pro/Max)                                       │
    │   Z.AI (GLM Coding Plan) … OpenRouter ● logged in …               │
    ╰────────────────────────────────────────────────────────────────────╯
                    ↑/↓ select · enter confirm · esc skip · ctrl+c exit setup
```

## The findings that matter

**1. The splash is not a separate screen — it is the backdrop of the setup wizard.** The
`omp` block mark, the starfield and the gradient water are *behind* a framed dialog. This
matches the traced source: `SetupWizardComponent` renders the splash art as **phase 0**
(`wizard-overlay.ts`, `scenes/splash.ts`, `SETUP_SPLASH_MS = 2600`), then cross-dissolves
into the scenes. So the "startup splash" a user sees on a first launch is the wizard's own
first phase, not a standalone animation.

**2. The mark is drawn in the terminal, not from an image.** The `███  ██` block glyphs and
the `·`/`✦`/`✧`/`▒░` density ramp are all text characters. `assets/lspv.webp` is therefore
**not** what renders here; it is a visual reference (or documentation), which is consistent
with the filename (`lspv` = LSP viewer) and with there being no image decoder in the TUI
path. Its role should be treated as reference-only unless the tree proves otherwise.

**3. The product name is baked into the art as `omp`.** That is the literal mark. For Prime
Pi the same composition must render a different noun — the brief is explicit that the
literal `omp` is not final branding.

**4. The visual identity is purple/magenta over a dark field, with a framed panel.** This
matches the theme work: OMP ships 102 themes, and this splash is drawn from the active
theme's colours, so it is *not* hard-coded purple — it follows whatever theme is configured.
Prime Pi must therefore render the same composition through its own theme system rather
than painting purple.

**5. Setup is 5 steps and is skippable** (`esc skip`), and the wizard shows live credential
state (`OpenRouter ● logged in (env: OPENROUTER_API_KEY)`).

## The trust-order question, answered by observation

OMP reaches this screen **with no trust prompt**, because **OMP has no project-trust
boundary** — confirmed both in source (`isProjectTrusted()` hardcoded `true`) and here in the
running product.

Prime Pi *added* trust. So Prime Pi cannot adopt OMP's ordering by removing trust. The
correct adaptation is narrower and was already correct in Prime Pi's code:

- built-in theme + built-in branding may initialise **before** trust, because they read only
  embedded resources (`startup-ui.ts` `loadStartupThemes` passes `projectTrusted: false`;
  OMP's `initThemeSync` reads only built-in JSON);
- project `.pi` resources stay trust-gated;
- the splash/setup composition renders at the point OMP renders it, which for a trusted or
  defaulting project is the setup wizard's phase 0.

So the target lifecycle for Prime Pi is:

    process start -> built-in theme (trust-independent) -> trust decision
                  -> project resources -> splash/setup phase 0 -> main UI

The trust screen itself remains the first *user-facing* frame on a fresh untrusted launch,
and must itself be Prime Pi branded and themed — which it now is.

## What Prime Pi shows instead, captured the same way

```
 Prime Pi v0.87.1
 escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
 Press ctrl+o to show full startup help and loaded resources.

 Prime Pi can explain its own features and look up its docs. Ask it how to use or extend Prime Pi.

[Context]  AGENTS.md
[Skills]   add-llm-provider, interactive-testing, release
[Prompts]  /cl, /deslop, /is, /pr, /sa, /wr
[Extensions] import-repro.ts, prompt-url-widget.ts, redraws.ts, tps.ts
```

Branding is correct. What is absent, and confirmed by direct comparison:

| | OMP 18.3.2 | Prime Pi |
|---|---|---|
| startup composition | starfield + block mark + gradient water behind a framed panel | flat resource list |
| first-run experience | 5-step setup wizard, skippable, live credential state | none |
| splash phase | wizard phase 0, `SETUP_SPLASH_MS=2600` | absent |
| theme registry | 102 themes | built-ins only |
| setup entry point | wizard on first run | none |

This is the measured basis for `product-parity-gap.md`. The gap is not "some themes are
missing"; it is that **the startup composition and the first-run wizard do not exist in
Prime Pi at all**, so none of the theme inventory is reachable by a user either.
