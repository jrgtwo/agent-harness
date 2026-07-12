import { WebSocket as WsWebSocket } from 'ws';
import { HarnessClient } from '../src/index';

// Dev-only testbed client: connect, ask a question, print the live trace, auto-approve consent.
// This dogfoods the client SDK and is the reference for how a real app consumes the harness.

const token = process.env.HARNESS_TOKEN ?? 'dev-token';
const port = Number(process.env.HARNESS_PORT ?? 4000);
const sessionId = process.env.SESSION_ID; // set this to keep memory across invocations
const question = process.argv.slice(2).join(' ') || 'What time is it right now?';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const out = (s: string) => process.stdout.write(s);

let client: HarnessClient;
client = new HarnessClient(`ws://127.0.0.1:${port}`, token, {
  WebSocketImpl: WsWebSocket as any,
  handlers: {
    onEvent: (runId, event) => {
      switch (event.type) {
        case 'token':
          out(event.text);
          break;
        case 'thinking':
          out(dim(event.text));
          break;
        case 'tool.requested':
          out(`\n${cyan(`▸ ${event.name}`)}(${JSON.stringify(event.args)})`);
          break;
        case 'consent.requested':
          out(dim(`  [consent: ${event.name} → auto-approving (demo)]\n`));
          client.decideConsent(runId, event.callId, true);
          break;
        case 'tool.finished':
          out(
            event.ok
              ? green(`  → ${JSON.stringify(event.result)}`) + dim(` (${event.ms}ms)\n`)
              : red(`  → error: ${event.error}\n`),
          );
          break;
        case 'model.call.finished':
          if (event.usage) out(dim(`\n${dim(`[${event.finishReason}; ${event.usage.totalTokens} tokens]`)}\n`));
          break;
        case 'run.finished':
          out(`\n\n${green('✔ done')}\n`);
          client.close();
          process.exit(0);
          break;
        case 'run.error':
          out(red(`\n✖ ${event.error}\n`));
          client.close();
          process.exit(1);
          break;
      }
    },
    onError: (err) => {
      out(red(`\nprotocol error [${err.code}]: ${err.message}\n`));
      process.exit(1);
    },
  },
});

const agents = await client.connect();
out(dim(`connected — agents: ${agents.join(', ')}${sessionId ? ` · session: ${sessionId} (memory on)` : ' · one-shot'}\n`));
out(`\n${cyan('you:')} ${question}\n`);
client.startRun(question, { sessionId });
