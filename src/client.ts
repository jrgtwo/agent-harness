// Browser-safe entry point: the client SDK plus the types a UI needs, with zero Node/ws in the
// emitted JS. transport/client.ts imports everything else as `import type` (erased at build) and only
// uses the global `crypto` + an injected/global `WebSocket`, so this bundle stays dependency-free and
// is safe to import from a browser bundler. Server code (Store, server, model client) lives on the
// default '.' entry — never import that from the browser.
export { HarnessClient, type HarnessClientHandlers, type HarnessClientOptions } from './transport/client';
export type { AgentEvent } from './core/events';
export type { ClientMessage, ServerMessage, ClientToolDecl } from './transport/protocol';
export type { Message } from './core/types';
export type { SessionInfo } from './store/store';
