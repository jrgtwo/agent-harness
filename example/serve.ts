import { createHarnessServer, OpenAICompatibleClient } from '../src/index';
import { exampleAgent } from './agent';

// Dev-only: start the harness sidecar with the example agent, pointed at your model.
// You bring the model — run a local llama-server / Ollama, or set MODEL_BASE_URL to a remote endpoint.

const baseUrl = process.env.MODEL_BASE_URL ?? 'http://127.0.0.1:5174/v1';
const model = process.env.MODEL_NAME ?? 'local';
const apiKey = process.env.MODEL_API_KEY;
const token = process.env.HARNESS_TOKEN ?? 'dev-token';
const port = Number(process.env.HARNESS_PORT ?? 4000);

const client = new OpenAICompatibleClient({ baseUrl, model, apiKey });
const handle = await createHarnessServer({ model: client, agents: [exampleAgent()], token, port });

console.log(`harness sidecar listening on ws://127.0.0.1:${handle.port}`);
console.log(`model:  ${model} @ ${baseUrl}`);
console.log(`token:  ${token}`);
console.log(`\nIn another terminal:  HARNESS_PORT=${handle.port} pnpm example "what time is it?"`);
