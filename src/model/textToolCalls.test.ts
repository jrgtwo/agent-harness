import { describe, expect, it } from 'vitest';
import { parseTextToolCalls } from './textToolCalls';

describe('parseTextToolCalls', () => {
  it('parses a <tool_call> block with a function and one parameter', () => {
    const text = `<tool_call>
<function=fetch_url>
<parameter=url>
https://example.com/x
</parameter>
</function>
</tool_call>`;
    expect(parseTextToolCalls(text)).toEqual([{ name: 'fetch_url', arguments: '{"url":"https://example.com/x"}' }]);
  });

  it('coerces numeric parameter values and keeps strings as-is', () => {
    const text = `<tool_call><function=web_search><parameter=query>rodgers</parameter><parameter=count>3</parameter></function></tool_call>`;
    expect(parseTextToolCalls(text)).toEqual([{ name: 'web_search', arguments: '{"query":"rodgers","count":3}' }]);
  });

  it('parses multiple tool_call blocks', () => {
    const text = `a <tool_call><function=f1><parameter=x>1</parameter></function></tool_call> b <tool_call><function=f2><parameter=y>hi</parameter></function></tool_call>`;
    expect(parseTextToolCalls(text)).toEqual([
      { name: 'f1', arguments: '{"x":1}' },
      { name: 'f2', arguments: '{"y":"hi"}' },
    ]);
  });

  it('returns [] when there is no tool_call block', () => {
    expect(parseTextToolCalls('just some prose about football')).toEqual([]);
  });
});
