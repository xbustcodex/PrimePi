# P3b — the seven "load-sensitive" failures: truthfully represented, no timeout raised

**Decision: leave them. They are healthy, and the evidence for that is now measured rather
than asserted.** No global timeout increase, no fixture weakening, no defect normalised
away.

## The claim being tested

Earlier the campaign recorded these as "load-sensitive — pass promptly in isolation,
verified individually". That was true but thin: it established only that they pass alone, not
*why*. The owner's instruction was to establish whether the operation completes promptly
rather than to accept a 120-second re-run as proof. So the mechanism was measured.

## Each case, re-run alone

    startup-session-name.test.ts        1 passed     5.27s   (tests 4.49s)
    trust-selector.test.ts              4 passed     4.06s   (tests  92ms)
    interactive-mode-status.test.ts    33 passed    31.92s   (tests 313ms)
    experimental-cli-entry.test.ts      3 passed    13.79s   (tests 12.99s)

All pass. All are fast *for what they do*.

## The mechanism, measured directly

`interactive-mode-status.test.ts` is the clearest case, and running it two ways settles it:

    whole file, 33 tests      wall = 35527ms   test-time = 324ms
    one test, 32 skipped      wall = 35094ms   test-time =  23ms

**Adding 32 tests costs 1ms of test time and nothing of wall time.** The 35 seconds is
vitest loading modules, and it is paid once per worker regardless of how many tests run.

The cause is the import graph, not the tests. `interactive-mode-status.test.ts:12` imports
`InteractiveMode`, which pulls in the entire interactive surface — TUI, themes, autocomplete,
extensions. `transform 18.66s, import 31.19s` in the run above.

So the full-suite failure is **contention for the module loader** when several workers
transform overlapping graphs simultaneously, not a slow test and not a defective one.

## Why this must not be "fixed" by raising timeouts

- A global `testTimeout` increase would make the suite green by allowing the *loader* to
  finish, and would simultaneously mask class C — the three genuine jiti
  `tsconfigPaths` timeouts measured at ~1.8s **per extension import**, which is a real
  product startup cost and does belong in the red set.
- It would be indistinguishable from fixing those, which is the opposite of what is wanted.
- The owner ruled it out explicitly: "do not solve load problems by globally increasing
  timeouts".

## Why these are healthy rather than merely fast

- 33/33 and 4/4 and 1/1 and 3/3 — no skips, no conditional assertions, no loosened
  expectations introduced here.
- The two suites with the largest wall time have the **smallest** test time, which is the
  opposite of a slow test.
- None of them was touched in this campaign except `experimental-cli-entry.test.ts`, whose
  fix (`70b42aba6`) was a Windows `--import` URL defect — a real one, now fixed.

## The distinction that matters for the red set

| | test time | wall time | verdict |
|---|---|---|---|
| these 7 | 92ms – 4.5s | up to 35s | module-load bound, healthy |
| class C (jiti) | 30s of real work | — | **genuine defect**, stays red |
| `extensions-discovery` | 30s of real work | — | **genine defect**, stays red |

So raising a timeout would have hidden the 3 real ones along with these 7. Keeping them
distinguished is the point.

## What would actually help, and why it is out of scope

The real cost is transforming the interactive-mode import graph once per worker. The fixes
are architectural — precompiling the test graph, or splitting `InteractiveMode` so a test
that only needs `showLoadedResources` does not import the whole surface. Both are worth
doing and neither is a failure-repair, so they are recorded as a performance item rather than
attempted here.
