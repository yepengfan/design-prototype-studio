# Local AI integration

Studio invokes Codex app-server over stdio JSON-RPC and Cursor Agent over ACP. Each request belongs to the backend, so closing the browser does not discard it. Progress and staged proposals are saved with the request's base revision. Explicit cancellation interrupts the owned request; partial output is never accepted automatically.

The model receives the selected project context and returns a structured source proposal. Studio owns file materialization, path checks, dependency validation, type checking, requirements review, and acceptance. The browser has no arbitrary shell endpoint. A proposal cannot silently change admitted packages or project commands. Invalid proposals receive a bounded correction attempt; unresolved failures remain visible with the accepted page unchanged.

On macOS an independent process sandbox restricts writes to the staging project and private runtime state. Codex retains its CLI-owned login namespace while logs and SQLite state are redirected. Its installation identifier and temporary helper directory are narrowly allowed runtime paths. Cursor uses private per-invocation configuration and data directories, a short runtime path for Unix socket limits, and its CLI-owned running marker. Hooks, plugins and other inherited extensions are controlled per invocation. Global login/configuration is not rewritten, and credentials are not copied into project source or exports.

A backend restart marks unfinished requests interrupted and preserves the accepted revision and pending annotations. Retry uses a fresh session against the saved source. Studio does not claim that a killed tool process can roll back external effects or that a conversation session is the recovery authority.

CLI protocols can change. An unsupported installation, missing login, inaccessible state store, or rejected permission remains a diagnostic rather than a successful generation. Source-proposal and streaming-cancellation probes have passed on the versions listed in the README; broader version compatibility is not assumed.

This is a local application integration. No commercial distribution or hosted-service authentication entitlement is asserted.
