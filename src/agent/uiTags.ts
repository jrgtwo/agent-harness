import type { JSONSchema } from '../core/types';

// Declarative UI tags: a symmetric, output-side sibling of tools. An app registers a tag ONCE (name +
// attribute schema + description) and writes the component; the harness owns the plumbing —
// teaching the model the emission syntax (renderUiTagInstructions, injected into the agent prompt)
// and finding + light-validating the tags in the model's answer (parseUiTags). The component and its
// rendering stay in the app. Emission syntax is Markdoc:
//   {% name attr="v" %}body{% /name %}   or self-closing   {% name attr="v" /%}
// This module is client-safe (pure string work + types), so a browser UI can parse tags too.

export interface UiTagDef {
  name: string;
  description: string;
  /** JSON Schema (object) for the tag's attributes — the same shape a tool uses for its params. */
  attributes: JSONSchema;
}

export interface ParsedUiTag {
  name: string;
  attributes: Record<string, string>;
  body: string;
}

function requiredKeys(schema: JSONSchema): string[] {
  const r = (schema as { required?: unknown }).required;
  return Array.isArray(r) ? (r as string[]) : [];
}

function propertyKeys(schema: JSONSchema): string[] {
  const p = (schema as { properties?: Record<string, unknown> }).properties;
  return p ? Object.keys(p) : [];
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out[(m[1] ?? m[3]) as string] = (m[2] ?? m[4]) as string;
  return out;
}

// Matches any registered tag name: {% name attrs /%} (self-closing) or {% name attrs %}body{% /name %}.
// The \1 backreference keeps the closing tag matched to its opener; attrs exclude % so a tag can't
// swallow the next one. The closing marker's `%` signs are optional — small models routinely emit a
// sloppy `{/name}` close while getting the opener right, and a strict close drops the whole card to
// raw text. The close stays anchored to the exact tag name, so leniency can't over-match prose.
function tagPattern(names: string[]): RegExp {
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\{%\\s*(${alt})\\b([^%]*?)(?:\\/%\\}|%\\}([\\s\\S]*?)\\{%?\\s*\\/\\1\\s*%?\\})`, 'g');
}

/** Find every registered tag in `text`, in order, keeping only those whose required attrs are present. */
export function parseUiTags(text: string, tags: UiTagDef[]): ParsedUiTag[] {
  if (!tags || tags.length === 0) return [];
  const byName = new Map(tags.map((t) => [t.name, t]));
  const re = tagPattern(tags.map((t) => t.name));
  const out: ParsedUiTag[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const def = byName.get(m[1] as string);
    if (!def) continue;
    const attributes = parseAttrs(m[2] ?? '');
    if (requiredKeys(def.attributes).some((k) => !(k in attributes))) continue;
    out.push({ name: m[1] as string, attributes, body: (m[3] ?? '').trim() });
  }
  return out;
}

/** Remove every registered tag from `text`, leaving the surrounding prose. */
export function stripUiTags(text: string, tags: UiTagDef[]): string {
  if (!tags || tags.length === 0) return text;
  return text
    .replace(tagPattern(tags.map((t) => t.name)), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Model-facing instructions teaching the tag vocabulary — appended to the agent's system prompt. */
export function renderUiTagInstructions(tags: UiTagDef[]): string {
  if (!tags || tags.length === 0) return '';
  const lines = tags.map((t) => {
    const props = propertyKeys(t.attributes);
    const req = new Set(requiredKeys(t.attributes));
    const example = `{% ${t.name} ${props.map((k) => `${k}="…"`).join(' ')} %}body{% /${t.name} %}`.replace(/\s+%\}/, ' %}');
    const attrList = props.map((k) => (req.has(k) ? `${k} (required)` : k)).join(', ') || '(none)';
    return `- ${example} — ${t.description}. Attributes: ${attrList}.`;
  });
  return (
    '\n\nUI TAGS — you may embed these tags inline in your answer; the app renders each as a component. ' +
    'Write them in Markdoc form, copy attribute values exactly, and CLOSE every tag:\n' +
    lines.join('\n')
  );
}
