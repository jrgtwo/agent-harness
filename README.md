# agent-harness

A small, model-powered agent harness. The richness of any product built with it lives in **apps**
on top — never stuffed into the harness itself.

> Scope test, applied forever: *"would every app want this?"* If not, it's an app, not the harness.

## What's here

The harness is a Node/TS **sidecar** (the brain: loop, model connection, tools, consent,
observability) plus a thin browser **client SDK**. An app runs the sidecar and talks to it over a
localhost WebSocket. Models are **bring-your-own** — the harness just accepts a connection URL.

Status: **walking skeleton** in progress — proving the core loop end-to-end before any breadth.

## Layout

- `src/` — the harness core (model client, tools, loop, events).
- `example/` — a dev-only testbed that dogfoods the client SDK; the reference for how apps consume
  the harness.

## Dev

```
pnpm install
pnpm test          # unit tests (vitest)
pnpm typecheck
```

You bring the model: run a local llama-server / Ollama (OpenAI-compatible), or point at a remote
endpoint + your own key.
