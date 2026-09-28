# PD-9 pre-install record

Recorded 2026-09-28, before any install. Authorization: narrow scope, the IAI
project's own declared dependencies into the IAI project's own venv only.

## Interpreter

```
.venv/pyvenv.cfg
  version            = 3.12.10
  include-system-site-packages = false
  executable         = C:\Users\xkali\AppData\Local\Microsoft\WindowsApps\
                       PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\python.exe
  command            = ... -m venv C:\Users\xkali\new_ai\iai-personal-memory-engine\.venv
```

`C:\Users\xkali\new_ai\iai-personal-memory-engine\.venv\Scripts\python.exe`

3.12.10 satisfies `requires-python = ">=3.11,<3.13"`.

## Installed state before install

```
$ .venv/Scripts/python.exe -m pip list
Package Version
------- -------
pip     25.0.1
```

That is the entire venv. No other package, no `iai_mcp` install. The engine has
only ever been importable via `PYTHONPATH` pointed at `build/lib.win-amd64-cpython-312`.

## Authoritative dependency declaration

`C:\Users\xkali\new_ai\iai-personal-memory-engine\pyproject.toml`, `[project]`,
project `iai-pme` version `2.7.3`, `requires-python = ">=3.11,<3.13"`.

Lockfile: **none.** No `requirements*.txt`, no `uv.lock`, no `poetry.lock`, no
`Pipfile`. `pyproject.toml` is therefore the sole authority.

Build backend: `setuptools>=68` + `setuptools-rust>=1.10`, packages under `src/`.

### Runtime dependencies (12, verbatim)

```
numpy>=1.26.0,<2.3.0
scipy>=1.13.0
numba>=0.59
tiktoken>=0.7.0
cryptography>=42.0.0
keyring>=24.0.0
cachetools>=5.3.0
psutil>=5.9.0
pandas>=2.0,<3.0
zstandard>=0.22,<1.0
pypdf>=4.0
setproctitle==1.3.7
```

**The earlier trace named three (numpy, scipy, numba). That list was wrong and
is not authority.** The other nine are equally hard requirements. Two of them
are load-bearing for the claims under test:

- `cryptography>=42.0.0` — the AES-256-GCM at-rest primitive.
- `keyring>=24.0.0` — Windows Credential Manager, so the key never lands in a
  file. A key lifecycle cannot be verified with this missing.

`zstandard` is called out in the project's own comments as *critical synchronous
at-rest path*, not an optional extra.

### Extras

`dev`, `migration`. **Neither is installed.** The dev extra pins
`networkx==3.3` for use as a test backend and sigma oracle; the migration extra
is for data movement. Neither is needed to prove the adapter, and installing
either would exceed the authorization.

## Install command

The project's own supported mechanism is `pip install -e .`, which reads
`pyproject.toml` and resolves the declared constraints. That is used verbatim.
No version pins are selected by hand, no constraint is relaxed, and no package
outside the declaration is added.

```
C:\Users\xkali\new_ai\iai-personal-memory-engine\.venv\Scripts\python.exe -m pip install -e C:\Users\xkali\new_ai\iai-personal-memory-engine
```

Targets that venv's interpreter explicitly. Not global, not PrimePi's
environment. IAI source is not modified; `-e` installs the checkout in place
and creates only the editable-install metadata plus `*.egg-info` in the project.

## What installation does not license

Modifying IAI source; installing undeclared packages; relaxing a constraint to
make the proof pass; touching Windows PATH or Python configuration; recreating
the venv; hand-editing the engine's persistence files; reading or logging
existing personal memories, keys, or secrets.

## Post-install verification

`pip list` and `pip check` are recorded after the install, and the resolved
versions are compared against the declared constraints above before any
functional proof is attempted.
