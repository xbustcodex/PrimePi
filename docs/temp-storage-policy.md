# Temporary build/test storage policy — PrimePi

Adopted 2026-10-01 after a disk-space cleanup found C: down to 16.8 GB free during a long
migration run. This is now part of the standing procedure: **before future long autonomous
runs, read this file.**

## The problem this solves

A long test campaign writes its scratch data to `os.tmpdir()`, which on this machine is
`C:\Users\xkali\AppData\Local\Temp`. One observed run left **3,214 `pi-*` directories**
behind. The data is disposable by construction, and C: is the smallest and busiest volume
here — the opposite of where it should go.

## Selected volume

    E:   NTFS, 236.9 GB total, 96.7 GB free   <- SELECTED
    D:   NTFS, 238.4 GB total, 71.9 GB free
    C:   NTFS, 237.2 GB total, 21.1 GB free

Measured, not assumed. **Re-measure before relying on this**: if E: falls below ~20 GB
free, re-run the selection over the available fixed drives and pick the largest.

## Layout

    E:\PrimePi-Temp\
      runs\<run-id>\     scratch for a single long session
      tests\<run-id>\    test scratch: temporary repos, fixtures, worktrees
      build\<run-id>\    compilation intermediates

Each run gets its own `<run-id>` — `20261001-190505` or `sweep-3` — so unrelated runs never
mix and a completed run can be deleted as one unit.

## How to redirect — and the trap

Node's `os.tmpdir()` on **Windows** reads `TEMP` and `TMP`. It **ignores `TMPDIR`**, which
is the variable the Linux/macOS documentation leads with.

Verified: with `TMPDIR` set, `os.tmpdir()` still returned
`C:\Users\xkali\AppData\Local\Temp`. With `TEMP`/`TMP` set, it returned the E: path.

    TEMP="E:\PrimePi-Temp\tests\<run-id>" TMP="E:\PrimePi-Temp\tests\<run-id>" npx vitest run ...

**Create the directory first.** Node resolves the path but does not create it.

Verify it worked — do not assume:

    # after the run, the run dir must be non-empty
    Get-ChildItem 'E:\PrimePi-Temp\tests\<run-id>' -Recurse

## What may be relocated, and what may not

**Safe to relocate** (disposable, reconstructible, no isolation semantics):

- test scratch: temporary git repositories, runtime fixtures, generated assets
- agent scratch/workspace directories
- temporary worktrees *where the tool supports it* — see the caveat below
- compilation intermediates
- transient logs

**Must stay where they are:**

- source repositories and `.git`
- session/recovery state, memory banks, credentials, configuration, user data
- authoritative databases
- anything needed to resume after a crash

**Tool-specific notes:**

- **git worktrees** — a worktree whose absolute-path symlinks point back into the original
  checkout does *not* provide an independent environment. Do not relocate a worktree and
  assume isolation you have not verified. (Discovered earlier in this project.)
- **npm** — its cache location is not env-redirectable in a supported way on this setup;
  use `npm cache verify` / `npm cache clean --force` instead.
- **pip** — `python -m pip cache purge`; the cache dir is configurable but there is no
  reason to move it.
- **Docker/Gradle/Cargo/rustup** — these hold dependency trees and toolchains. Not
  relocation candidates; clean via each tool's own cache command if needed.

## Lifecycle — required, not optional

**After a successful run:**

1. identify the run's directories
2. confirm no process still uses them
3. confirm they hold no authoritative state or needed failure evidence
4. preserve any failure artifact still needed for debugging
5. delete the run's disposable data
6. verify the deletion
7. report the recovered space

**After an interrupted or crashed run:** inspect the directory first. It may hold recovery
state. Do not delete blind.

## Free-space checks during long campaigns

Record before and after, at sensible boundaries:

    Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -eq 3} |
      ForEach-Object { "{0} free={1} GB" -f $_.DeviceId, [math]::Round($_.FreeSpace/1GB,1) }

If C: is losing space *despite* this policy, **identify the producer** rather than deleting
files to make the number look better. The objective is:

    C:    OS + applications + authoritative development state
    E:    high-volume disposable build/test scratch
    done  scratch deleted after verification
