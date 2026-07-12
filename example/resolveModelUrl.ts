import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Dev convenience (example-only, not harness core): figure out which host actually reaches the
// user's model, so `pnpm serve` works with no env vars — including the WSL → Windows gateway case.

const PORT = process.env.MODEL_PORT ?? '5174';

export interface ResolvedModel {
  baseUrl: string;
  /** How we arrived at it, for a helpful log line. */
  how: string;
}

export async function resolveModelUrl(): Promise<ResolvedModel> {
  if (process.env.MODEL_BASE_URL) {
    return { baseUrl: process.env.MODEL_BASE_URL, how: 'MODEL_BASE_URL (explicit)' };
  }

  const gateway = wslGatewayIp();
  const candidates: { host: string; label: string }[] = [{ host: '127.0.0.1', label: 'localhost' }];
  if (gateway) candidates.push({ host: gateway, label: `WSL→Windows gateway ${gateway}` });

  for (const c of candidates) {
    const baseUrl = `http://${c.host}:${PORT}/v1`;
    if (await reachable(baseUrl)) return { baseUrl, how: `auto-detected (${c.label})` };
  }

  // Nothing answered yet (model probably not started). Pick the most likely host so it works
  // once the model comes up: the gateway in WSL, else localhost.
  const fallback = gateway ?? '127.0.0.1';
  const label = gateway ? `WSL→Windows gateway ${gateway}` : 'localhost';
  return { baseUrl: `http://${fallback}:${PORT}/v1`, how: `default, unverified (${label} — model not reachable yet)` };
}

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function wslGatewayIp(): string | undefined {
  if (!isWsl()) return undefined;
  try {
    const out = execSync('ip route show default', { encoding: 'utf8' });
    return out.match(/default via (\d+\.\d+\.\d+\.\d+)/)?.[1];
  } catch {
    return undefined;
  }
}

/** True if the host answers on the model port at all (any HTTP status = the server is there). */
async function reachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    await fetch(`${baseUrl}/models`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
