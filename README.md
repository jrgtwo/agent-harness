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
pnpm test          # unit + over-the-wire integration tests (vitest)
pnpm typecheck
```

## Run the walking skeleton against a real model

You bring the model. Start a local llama-server / Ollama (OpenAI-compatible), or point at a remote
endpoint + your own key. Then, in two terminals:

```
# terminal 1 — the harness sidecar (point it at your model)
MODEL_BASE_URL=http://127.0.0.1:5174/v1 MODEL_NAME=local pnpm serve

# terminal 2 — the testbed client (asks a question, prints the live trace)
pnpm example "what time is it right now?"
pnpm example "what is 12 * (3 + 4)?"
```

**Multi-turn memory** — set `SESSION_ID` to make consecutive runs share history (persisted in SQLite,
so it survives a restart):
```
SESSION_ID=demo pnpm example "my name is Jon"
SESSION_ID=demo pnpm example "what's my name?"    # remembers
```

Env: `MODEL_BASE_URL`, `MODEL_NAME` (default `local`), `MODEL_API_KEY` (for a remote endpoint),
`HARNESS_TOKEN` (default `dev-token`), `HARNESS_PORT` (default `4000`).

**Success bar:** you see the model decide to call a tool, a consent line, the tool result in the
live trace, and a streamed answer — all end to end. That's the spine proven.
