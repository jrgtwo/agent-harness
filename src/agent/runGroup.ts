import type { AgentEvent } from '../core/events';

// Bounded fan-out: run many independent runs concurrently, keeping `concurrency` in flight and
// starting the next as each settles, then resolve when all settle. Plain async — no React, no timers,
// no refs — so the concurrency mechanics live somewhere testable and reusable, not in an app's render
// cycle. The app keeps its workflow (what to run, in what order) and its UI (react to `onEvent`).

/** The slice of HarnessClient runGroup needs — HarnessClient satisfies this structurally. */
export interface RunGroupClient {
  startRun(input: string, opts: { agent?: string; onEvent?: (event: AgentEvent) => void }): string;
  cancel(runId: string): void;
}

export interface RunGroupItem {
  input: string;
  agent?: string;
}

export interface GroupItemResult {
  runId: string;
  status: 'done' | 'error' | 'aborted';
  result?: unknown;
  error?: string;
}

export interface RunGroupOptions {
  /** Max runs in flight at once. */
  concurrency: number;
  /** Per-item events for the app's UI: (item index, its runId, the event). */
  onEvent: (index: number, runId: string, event: AgentEvent) => void;
  /** Abort → stop starting queued items and cancel the in-flight ones (they resolve as 'aborted'). */
  signal?: AbortSignal;
}

export async function runGroup(
  client: RunGroupClient,
  items: RunGroupItem[],
  { concurrency, onEvent, signal }: RunGroupOptions,
): Promise<GroupItemResult[]> {
  const results: GroupItemResult[] = new Array(items.length);
  const inFlight = new Map<number, { runId: string; abort: () => void }>();
  let cursor = 0;
  let aborted = signal?.aborted ?? false;

  const onAbort = () => {
    aborted = true;
    for (const rec of inFlight.values()) {
      client.cancel(rec.runId);
      rec.abort();
    }
  };
  signal?.addEventListener('abort', onAbort);

  const runOne = (index: number): Promise<GroupItemResult> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (r: GroupItemResult) => {
        if (settled) return;
        settled = true;
        inFlight.delete(index);
        resolve(r);
      };
      const runId = client.startRun(items[index]!.input, {
        agent: items[index]!.agent,
        onEvent: (event) => {
          onEvent(index, runId, event);
          if (event.type === 'run.finished') finish({ runId, status: 'done', result: event.result });
          else if (event.type === 'run.error') finish({ runId, status: 'error', error: event.error });
        },
      });
      inFlight.set(index, { runId, abort: () => finish({ runId, status: 'aborted' }) });
    });

  const worker = async () => {
    while (!aborted && cursor < items.length) {
      const i = cursor++;
      results[i] = await runOne(i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  signal?.removeEventListener('abort', onAbort);
  return results;
}
