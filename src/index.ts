// Public surface of the harness.
export * from './types';
export * from './events';
export { OpenAICompatibleClient } from './openaiClient';
export { ToolRegistry, type ToolDef, type ConsentMode, type ValidationResult } from './tools';
export { run, type RunOptions, type RunResult, type ConsentFn, type ConsentRequest, type StopReason } from './loop';
export { Store, type SessionInfo } from './store';
export { createHarnessServer, type Agent, type HarnessServerOptions, type HarnessServerHandle } from './server';
export { HarnessClient, type HarnessClientHandlers, type HarnessClientOptions } from './client';
export {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type ClientToolDecl,
} from './protocol';
