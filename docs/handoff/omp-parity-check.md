# OMP parity reconciliation

Checked after the P0–P3 work. Scoped to what this campaign changed, because a blanket
"parity" claim would be unfalsifiable.

## The reference was not modified

    OMP HEAD     eabd6b99c638
    dirty files  ?? tree.txt

One untracked file, `tree.txt`, which was already present at the start of this campaign —
the same artifact noted in the first session. No tracked file in `oh-my-pi` was touched.

## P0 — the transport posture matches

Byte-level comparison of the template literal that builds the pipe name:

    OMP  "? `\\\\.\\pipe\\omp-collab-${entryId}`"
    Pi   "return `\\\\.\\pipe\\${prefix}-${serverId}-${nonce}`;"

Both build `\\.\pipe\…`. Six further checks:

| property | OMP | PrimePi |
|---|---|---|
| binds `\\.\pipe\` | yes | yes |
| endpoint id from `randomBytes(8)` | yes | yes (a validated 12–32 hex generation nonce) |
| token from `randomBytes(32)` | yes | yes (supplied by the caller, never derived from the endpoint) |
| constant-time compare (`timingSafeEqual`) | yes | yes |
| credential required or not, per platform | token on the pipe | token required on the pipe, **absent** on POSIX so the socket keeps working |
| endpoint identity from the pathname | no — proved in-band | no — proved in-band |

**Divergences, both deliberate and both improvements:**

1. **OMP's daemon broker compares its bearer with plain `!==`** (`launch/broker.ts:546`);
   its collab registry uses `timingSafeEqual` (`collab/registry.ts:211`). PrimePi uses the
   stronger of the two upstream patterns.
2. **OMP always sends a token.** PrimePi sends one only where the transport cannot restrict
   the endpoint by itself, so the POSIX path keeps relying on `0700`/`0600` and nothing about
   the existing contract changes.

## P1 — each decision against OMP

| area | OMP | PrimePi | agree? |
|---|---|---|---|
| `session_start` handler exists | yes (`autoresearch/index.ts:247`) | yes | yes — and neither sends a user message from it |
| `sendUserMessage` is fire-and-forget, void | yes (`loader.ts:117`) | yes | yes |
| npm self-update is gated | yes (`cli/update-cli.ts`) | yes | yes |

**Two areas OMP has no opinion on**, so PrimePi's choice is unconstrained by parity:

- **Parity ledger.** No equivalent exists in OMP — `grep -rln "parity-ledger|settings-parity"
  packages/` returns nothing. The decision followed PrimePi's own authority `a79f406b3`.
- **Compaction auth ordering.** OMP's `command-controller.ts:1539` checks message count
  first, but that guard *warns and returns* from a UI controller and is not coupled to any
  auth check. It is not a statement about ordering.

And one where OMP **has** the behaviour PrimePi lacks, which is why it is a finding rather
than a decision:

- **Compaction auth gate is unreachable on the SDK path.** `agent-session.ts:1021` compares
  `agent.streamFunction === streamSimple`, and `sdk.ts:427` always installs a wrapper, so
  the branch never fires for a session created through `createAgentSession`. Recorded in
  `E:\PrimePi-Temp\tools\p1b-compaction-decision-append.md` as a design call, not fixed.

## What parity does *not* claim

- No live-turn verification. External credit remains the blocker, and PD-6/PD-8 stay open.
- The Windows discovery gap is a capability PrimePi has and OMP does not, so it is not a
  parity item — it is recorded as a build item in the migration plan.
- The `jiti` extension-loader cost is byte-identical to upstream pi, so matching upstream
  means keeping it. Recorded as an upstream defect.

## Method note

The first parity probe reported two false `DIFF`s, because its regex escaping did not match
either file. The literal read of the source lines contradicted it, and the byte-level check
confirmed both bind the same prefix. Worth recording: a parity claim produced by a regex
against escaped string literals is not evidence, which is the same lesson as the four wrong
pipe-name patterns in `8382655f8`.
