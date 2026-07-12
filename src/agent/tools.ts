import Ajv, { type ValidateFunction } from 'ajv';
import type { JSONSchema, ModelToolSchema } from '../core/types';

/**
 * Consent mode a tool declares. v1 policy gates everything except explicit `auto`
 * (see the loop); `propose` exists but the first apps don't need it.
 */
export type ConsentMode = 'auto' | 'confirm' | 'propose';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Also what the model receives. */
  params: JSONSchema;
  mode: ConsentMode;
  handler: (args: any) => Promise<unknown> | unknown;
}

export type ValidationResult = { ok: true } | { ok: false; errors: string };

const ajv = new Ajv({ allErrors: true, strict: false });

/** A per-agent collection of tools. Isolation is by construction: an agent gets one registry. */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private validators = new Map<string, ValidateFunction>();

  register(tools: ToolDef[]): void {
    for (const t of tools) {
      this.tools.set(t.name, t);
      this.validators.set(t.name, ajv.compile(t.params));
    }
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Schemas to hand the model. */
  schemas(): ModelToolSchema[] {
    return this.all().map((t) => ({ name: t.name, description: t.description, parameters: t.params }));
  }

  /** Validate parsed args against the tool's JSON Schema before the handler ever runs. */
  validate(name: string, args: unknown): ValidationResult {
    const v = this.validators.get(name);
    if (!v) return { ok: false, errors: `no validator registered for "${name}"` };
    if (v(args)) return { ok: true };
    const errors = (v.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`).join('; ');
    return { ok: false, errors: errors || 'failed schema validation' };
  }
}
