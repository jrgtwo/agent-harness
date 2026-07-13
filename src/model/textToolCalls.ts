// Fallback tool-call parser for models that emit tool calls as TEXT (e.g. some local / reasoning
// models via llama-server) instead of the structured OpenAI `tool_calls` field. Handles the
// `<tool_call><function=NAME><parameter=KEY>VALUE</parameter>…</function></tool_call>` format.
// Used only when no structured tool_calls were returned, so it never affects models that behave.

export const TOOL_CALL_BLOCK = /<tool_call>[\s\S]*?<\/tool_call>/g;

export function parseTextToolCalls(text: string): { name: string; arguments: string }[] {
  const calls: { name: string; arguments: string }[] = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  for (let m = blockRe.exec(text); m; m = blockRe.exec(text)) {
    const inner = m[1] ?? '';
    const fn = inner.match(/<function=([^>\s]+)\s*>/);
    if (!fn) continue;
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
    for (let p = paramRe.exec(inner); p; p = paramRe.exec(inner)) {
      const key = p[1] ?? '';
      const raw = (p[2] ?? '').trim();
      // Coerce JSON scalars (numbers/booleans/null); keep everything else as a string.
      try {
        args[key] = JSON.parse(raw);
      } catch {
        args[key] = raw;
      }
    }
    calls.push({ name: fn[1] ?? '', arguments: JSON.stringify(args) });
  }
  return calls;
}
