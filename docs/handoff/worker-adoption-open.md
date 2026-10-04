# Open: a replacement server does not adopt the previous generation's Session worker

**Status:** 7 of 27 `experimental-remote-runtime.test.ts` cases. Genuine Windows capability
gap, **not** external, **not** upstream. Highest-value remaining item.

## Symptom

    PROBE: replacement started, awaiting first.closed
    PROBE: first.closed resolved                                  <- replacement handshake OK
    PROBE: replacement.serverId = 17cbf2dd-…  first.serverId = 17cbf2dd-…   <- same identity
    PROBE: ids match; workerPids.get("demo-1") = undefined   expected 54656

Identity is inherited and the old server retires cleanly. **Worker adoption is what does
not happen**, so `workerPids.get(sessionId)` is `undefined`.

## The adoption path is platform-neutral, which is the clue

    server.ts:732                  await workers.discover(coordinator.peerIds)
    session-worker-manager.ts:164  await this.#coordinator.broadcast({ type: "discover_workers" })
    session-worker.ts:692          onDiscovery: announce
    session-worker.ts:676          announce() -> control.send({ type: "worker_ready", ... })
    session-worker-manager.ts:652  #recordReadyWorker(peerId, message)

`discover` has a 5s timeout (`WORKER_DISCOVERY_TIMEOUT_MS`) and resolves either way, so a
missed adoption is **silent** — the only symptom surfaces much later as an undefined pid.

The worker is designed to outlive its server: `session-worker.ts:231` `serverDisconnected`
starts an orphan-demand grace timer instead of exiting, and `control.socket.once("close",
closeAndExit)` means it dies only if its **coordinator** connection drops.

## The architectural asymmetry, traced

    server.ts:695  startupLease = await ensureCoordinator(socketPath, controlPath)
    server.ts:696  coordinator  = new CoordinatorConnection({ controlPath, endpoint: serverPath })
    coordinator.ts:317  await listen(publicServer, publicPath)      <- coordinator binds socketPath
    coordinator.ts:446  createConnection(currentServer.endpoint)     <- proxies to what it was told

The coordinator is spawned with **`socketPath`** and binds it. The server separately binds
**`serverPath`** — a *different* name on both platforms, since `socketPath` and `serverPath`
come from different nonces.

On POSIX that is harmless: a socket file can be `link`ed, so the coordinator's
`publicPath` and the server's own listener can be the same inode reached by two names.
**A named pipe has no such aliasing.** So on Windows:

- the coordinator binds a pipe named by `socketPath`'s nonce;
- the server binds a pipe named by `serverPath`'s nonce;
- the coordinator proxies public connections to `currentServer.endpoint`, which is
  `serverPath` — so proxying works;
- but anything that resolves the coordinator's *own* `publicPath` — including a client
  that discovered it from a registry entry published before the replacement — reaches a
  pipe that is no longer bound by the server that replaced it.

That last point is the adoption failure: the surviving worker was told the *previous*
server generation's endpoint, and after replacement the coordinator's routing and the
worker's recorded endpoint no longer agree.

## Why this needs design rather than a patch

Three coherent options, none a local repair:

1. **Publish the coordinator's `publicPath` as the server's endpoint.** One pipe per
   server generation, the coordinator owns it, and the server registers the coordinator's
   name rather than its own. Simplest and removes the asymmetry entirely — but it changes
   what the server binds on POSIX too, so it is a cross-platform behavioural change to a
   subsystem that currently passes on both.
2. **Keep two endpoints and have the registry record both.** More state, and the registry
   would then be nominating a *pair*, which weakens its "smallest thing that works" shape.
3. **Re-register workers against the coordinator on `server_connected`.** The worker
   already handles `server_connected`; make adoption explicit rather than relying on a
   broadcast that races the replacement.

Option 3 is the smallest and touches only the adoption path, but it needs the probe below
to show the broadcast is in fact reaching the worker.

## The next action, precisely

One probe, then a decision:

1. Log the coordinator's `broadcast({ type: "discover_workers" })` fan-out at
   `coordinator.ts:437` and the worker's `announce()` at `session-worker.ts:676` on the
   replacement path.
2. If the broadcast **reaches** the worker and `worker_ready` comes back but
   `#recordReadyWorker` drops it, the rejection is in its validation
   (`sessionKey`/`sessionId`/absolute paths) — a local fix.
3. If the broadcast **does not reach** the worker, the worker's coordinator peer
   connection is gone, and options 1-3 above apply.

That single probe distinguishes a local repair from an architectural change, and it is the
reason this is recorded rather than guessed at.
