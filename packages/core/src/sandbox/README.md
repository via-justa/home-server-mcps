# sandbox/

`isolated-vm` runner for `search(code)` and `execute(code)`: a fresh isolate per call, plugin binding
functions, read-only `catalog`/`registry`/`guides` APIs, time/memory/result limits.

`isolated-vm` is a native dependency and is added in this phase, not in the skeleton.

Design: §5.1, §5.4. Phase 7 in §13.
