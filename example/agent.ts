import { ToolRegistry, type Agent } from '../src/index';
import { calculate, getCurrentTime } from './tools';

/** The example agent: config over the shared harness — a prompt + a small tool set. */
export function exampleAgent(): Agent {
  const tools = new ToolRegistry();
  tools.register([getCurrentTime, calculate]);
  return {
    name: 'assistant',
    systemPrompt: [
      'You are a helpful assistant running inside a local agent harness.',
      'You have tools. When the user asks for the current time or date, or for any arithmetic,',
      'you MUST call the appropriate tool rather than answering from memory.',
      'After a tool returns, use its result to answer the user concisely.',
    ].join(' '),
    tools,
  };
}
