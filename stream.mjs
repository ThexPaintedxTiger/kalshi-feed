// Entry point kept for compatibility: `node stream.mjs` starts the live daemon (live/daemon.mjs).
// Use start.sh (Mac/Linux) or start.cmd (Windows) instead: they restart it if it ever exits.
await import("./live/daemon.mjs");
