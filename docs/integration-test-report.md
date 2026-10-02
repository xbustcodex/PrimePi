# Full-system integration testing — findings

Recorded 2026-10-02, from `3aae75ef3` to `97a297ac1`. Written because the failures here
share a shape worth naming, and the shape is not obvious from a commit message.

## Result

    packages/coding-agent   152 failed -> 106 failed   (3841 -> 3887 passed)
    npm run check           exit 0
    tsgo --noEmit           0 errors

Every failing file was classified mechanically — HEAD's copy of the file, run, restored —
and none of the 43 was introduced by the work that followed.

## Four defects fixed

| Defect | How it surfaced |
| --- | --- |
| A **deny rule was bypassed by any allow listed above it** | 7 compound-command tests |
| A partial interactive mode **crashed** on the keybinding diagnostic | 21 tests, 3 files |
| A Windows path as a grep pattern **crashed ripgrep** with "invalid hexadecimal digit" | full-suite run |
| Two suites **only told the truth when the machine was idle** | sequential-vs-parallel comparison |

The deny bypass is the one that mattered. `firstMatch` returned the first matching
rule, so a catch-all `*` allow above a `^rm` deny shadowed it and every `rm` in a chain
was allowed. `decideChain` is the live path — `core/security/tool-approval.ts` calls it
for every bash approval.

## The defect class that dominated: silence

Six of the eight commits are the same failure in different clothes — an instrument that
reported a confident answer it had not computed.

    inert scanner, wrong cwd         0 symbols   (reported "nothing is unreferenced")
    collectFiles, unreadable dir     partial corpus, no warning
    8 audit scripts, wrong cwd       0 members    (reported "no inert members")
    resource-loader, process.cwd()   ENOENT only under one invocation
    inert-detector, 180s hook budget scan cut short, memo stayed undefined
    grep, ripgrep parse error        surfaced verbatim to the user

None of these announce themselves. They return a plausible value. The general rule this
program keeps relearning: **a tool that cannot tell should say so, and a tool that can
should be exercised from a second direction** — a different working directory, a
different execution mode, a different machine speed. Every one of the six was green in
isolation and wrong in a context that mattered.

## Corrections to my own work

Recorded because the count of things I got wrong and then fixed against the tree is part
of the result:

- Claimed `this.showStatus` was missing on **74 call sites**. It exists, at line 3809; my
  grep had filtered out its own declaration. Verified against the built prototype before
  changing anything.
- Claimed `hasPartialPlaceholder`'s doc described a real stream-split risk. Both redaction
  boundaries redact whole messages.
- Wrote a test for `node:test` in a vitest package. It "passed" because I ran it directly
  with `tsx`; under the real runner it reported *no test suite found*.
- Reported a settings **persistence defect** that was my probe not awaiting `flush()`.
- Rewrote a repair script that corrupted `grep.ts` into a 14-error state, by reading and
  writing without an encoding.

## What cannot be verified here

A complete assistant turn. Every configured credential is unfunded:

    OpenRouter  402 "insufficient credits - this account never purchased credits"
    xAI         403 "your newly created team doesn't have any credits or licenses yet"
    OpenAI      401 — OPENAI_API_KEY in the environment holds an OpenRouter key

That is account state, not a defect. What *is* verified against the shipped 60-file
bundle: the agent assembles, a turn starts, credentials resolve per provider, and the
outbound request is delivered — proved by the upstream provider's own HTTP status coming
back through the event stream.

## Evidence ladder

    132 unregistered      251 registered       0 implemented
     69 runtime-reachable  23 behaviourally-verified   4 live-verified

`reconcile-evidence` reports zero ladder violations: LIVE-VERIFIED ⊆ BEHAVIOURALLY-VERIFIED
⊆ RUNTIME-REACHABLE ⊆ REGISTERED holds.

## Remaining 106 failures

    ~44  environmental
          24  POSIX-only unix-socket transport, unavailable on Windows
           8  symlink creation EPERM on this Windows account
           6  cwd-relative path double-prefixed by the runner
           3  tool download blocked — the isolated HOME has no network
           3  ESM loader receives a path without a file:// scheme
    ~62  to work through

Note that the environmental count is measured, not assumed: several tests that appeared
environmental turned out to be cwd and budget defects, which is why each was chased to a
cause rather than filed.