// Public surface of the harness.
export * from './core/types';
export * from './core/events';
export { OpenAICompatibleClient } from './model/openaiClient';
export { ToolRegistry, type ToolDef, type ConsentMode, type ValidationResult } from './agent/tools';
export {
  run,
  type RunOptions,
  type RunResult,
  type ConsentFn,
  type ConsentRequest,
  type StopReason,
  type ContextConfig,
} from './agent/loop';
export {
  estimateTokens,
  capText,
  injectLiveState,
  compactHistory,
  summarizeMessages,
  type CompactParams,
  type CompactResult,
} from './agent/context';
export { Store, type SessionInfo } from './store/store';
export {
  createHarnessServer,
  type Agent,
  type HarnessServerOptions,
  type HarnessServerHandle,
} from './transport/server';
export { HarnessClient, type HarnessClientHandlers, type HarnessClientOptions } from './transport/client';
export { parseClientMessage, type ClientMessage, type ServerMessage, type ClientToolDecl } from './transport/protocol';
