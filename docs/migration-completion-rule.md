# PrimePi completion rule: migration is not complete until it is green

Adopted from the owner on 2026-09-30. This file is the authority for *how* work
is sequenced. AGENTS.md remains the authority for repository operation.

## The objective

Not:

    migrate everything first → test everything later

But:

    migrate → integrate → exercise → break → fix → retest → prove → commit → continue

Do not accumulate a giant untested migration tail. If ten related capabilities
are migrated, those ten are integrated and exercised before that subsystem is
declared complete.

## Per-capability sequence

1. Read and understand the current OMP implementation and its tests.
2. Implement or integrate through the correct PrimePi production authority.
3. Prove the production path actually reaches it.
4. Exercise it with realistic inputs — not construction or import tests.
5. Test its Settings/configuration controls where applicable.
6. Test normal behavior.
7. Test boundary and sentinel values.
8. Test failure and error behavior.
9. Test interaction with adjacent PrimePi capabilities.
10. Add regression tests for every defect discovered.
11. Run the relevant focused suite.
12. Run the relevant package/integration suite.
13. Build the affected packages.
14. Exercise the installed/live path where it can safely be exercised.
15. Fix every deterministic regression introduced by the migration.
16. Repeat until that coherent subsystem is green.
17. Only then update its evidence classification and commit.
18. Then continue automatically to the next subsystem.

If testing exposes a defect in something migrated earlier, follow the defect back
to its owner, fix it, add a regression test, rerun the affected gates, and
restore green before continuing.

## What "green" means

Green does **not** mean:

- a source file exists;
- a Settings row exists;
- TypeScript compiles;
- helper unit tests pass;
- production code imports the helper;
- the ledger says migrated;
- a reachability detector sees a reference.

Green means the strongest evidence available for that capability has passed:

    implementation exists
    → production integration exists
    → production result is actually consumed
    → behavioral tests exercise that integration
    → failure and boundary cases pass
    → relevant integration and regression tests pass
    → affected builds pass
    → live/installed verification passes where locally possible

If live verification needs unavailable credentials, external infrastructure,
native hardware or vendor services, record that separately as **external
verification debt**. Do not falsely call it live-verified, and do not let it block
unrelated local work.

## Test the migration as a system

Individual green capabilities are necessary but not sufficient. As capabilities
accumulate, run increasingly broad integration gates so individually correct
components are proven to work together. Cover at least:

    settings → runtime consumer
    session → memory → context → model turn
    provider → retry → fallback → eligibility → funding policy
    tool request → approval → execution → result → session
    edit → staleness protection → formatting → persistence
    task → delegation → isolation → execution → integration
    context growth → compaction → persistence → resume
    project trust → LSP/tools/extensions
    failure → recovery → continued session operation

Do not wait for a final parity sweep to discover two migrated subsystems conflict.

## Never hide a failure

Do not hide failures by:

- deleting tests;
- weakening assertions;
- increasing arbitrary timeouts;
- marking failures flaky without evidence;
- changing expected results to match broken behavior;
- swallowing exceptions;
- silently skipping tests;
- reclassifying failures as baseline without mechanical proof.

Pre-existing and environmental failures must be reproduced and classified
separately, with evidence. The TypeScript baseline must stay mechanically
unchanged unless independently re-established.

## Completion condition

"Everything migrated" is not completion. Completion requires:

- everything applicable migrated or explicitly classified;
- production reachability reconciled;
- behavioral verification reconciled;
- all locally testable migrated functionality exercised;
- deterministic regressions fixed;
- relevant package and integration suites green;
- all builds green;
- installed/live paths verified where locally possible;
- remaining external verification debt explicitly enumerated;
- standing exclusions explicitly enumerated;
- repository clean;
- final parity reconciliation complete.

After migration ends, keep testing and fixing until that condition is reached.
Do not hand the owner a pile of migrated code and a list of tests that still need
to be run.
