# sandbox/

`isolated-vm` runner for `search(code)` and `execute(code)`: a fresh isolate per call, frozen binding
namespaces, JSON-only boundary, a wall-clock budget that bindings pause while waiting on human approval,
and memory/result/log caps. Node must run with `--no-node-snapshot`.

Design: §5.4. Phase 7 in §13.
