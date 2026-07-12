import type { ToolDef } from '../src/index';

// These are *example* tools — they live with the example app, not in the harness core.
// (A tool only belongs in the harness if every app would want it.)

export const getCurrentTime: ToolDef = {
  name: 'get_current_time',
  description:
    'Return the current date and time in ISO 8601. Use this whenever the user asks what time or date it is — you do not know it otherwise.',
  mode: 'confirm',
  params: { type: 'object', properties: {}, additionalProperties: false },
  handler: () => ({ iso: new Date().toISOString() }),
};

export const calculate: ToolDef = {
  name: 'calculate',
  description:
    'Evaluate a basic arithmetic expression such as "12 * (3 + 4)". Use this for any arithmetic instead of computing it yourself.',
  mode: 'confirm',
  params: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
    additionalProperties: false,
  },
  handler: (args: { expression: string }) => ({ result: evalArithmetic(args.expression) }),
};

/** A tiny safe arithmetic evaluator (+ - * / and parentheses). No eval / Function. */
function evalArithmetic(expr: string): number {
  const tokens = expr.match(/\d+\.?\d*|[+\-*/()]/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parseExpr = (): number => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = parseFactor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseFactor = (): number => {
    const t = next();
    if (t === '(') {
      const v = parseExpr();
      if (next() !== ')') throw new Error('missing closing parenthesis');
      return v;
    }
    if (t === '-') return -parseFactor();
    const n = Number(t);
    if (t === undefined || Number.isNaN(n)) throw new Error(`unexpected token: ${t ?? '(end)'}`);
    return n;
  };

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error('unexpected trailing input');
  return result;
}
