import { describe, expect, it } from 'vitest';
import { parseUiTags, renderUiTagInstructions, stripUiTags, type UiTagDef } from './uiTags';

const player: UiTagDef = {
  name: 'player',
  description: 'a player card in a ranking',
  attributes: {
    type: 'object',
    properties: { id: { type: 'string' }, rank: { type: 'string' }, tier: { type: 'string' }, badge: { type: 'string' } },
    required: ['id'],
  },
};
const tag = (attrs: string, body: string) => `{% player ${attrs} %}${body}{% /player %}`;

describe('parseUiTags', () => {
  it('finds registered tags in order with attributes + body', () => {
    const text = `Board:\n${tag('id="P3" rank="1" tier="1" badge="steal"', 'Proven ceiling.')}\n${tag('id="P1" rank="2"', 'Floor.')}`;
    const out = parseUiTags(text, [player]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'player', attributes: { id: 'P3', rank: '1', tier: '1', badge: 'steal' }, body: 'Proven ceiling.' });
    expect(out[1]!.attributes).toEqual({ id: 'P1', rank: '2' });
  });

  it('parses a self-closing tag (no body)', () => {
    expect(parseUiTags('{% player id="P2" /%}', [player])).toEqual([
      { name: 'player', attributes: { id: 'P2' }, body: '' },
    ]);
  });

  it('drops tags missing a required attribute', () => {
    expect(parseUiTags(tag('rank="1" tier="1"', 'no id'), [player])).toEqual([]);
  });

  it('tolerates a sloppy close with dropped % markers ({/name})', () => {
    // Small models often emit a correct opener but a bare `{/player}` close; still render the card.
    expect(parseUiTags('{% player id="P1" rank="1" %}Anchor pick.{/player}', [player])).toEqual([
      { name: 'player', attributes: { id: 'P1', rank: '1' }, body: 'Anchor pick.' },
    ]);
  });

  it('ignores an unclosed (streaming) tag and unregistered tags', () => {
    const text = `${tag('id="P1"', 'done')}\n{% chart x="1" %}other{% /chart %}\n{% player id="P2" %}still typing…`;
    expect(parseUiTags(text, [player]).map((t) => t.attributes.id)).toEqual(['P1']);
  });

  it('returns [] with no registered tags', () => {
    expect(parseUiTags(tag('id="P1"', 'x'), [])).toEqual([]);
  });
});

describe('stripUiTags', () => {
  it('removes registered tags, leaving prose', () => {
    const text = `${tag('id="P1"', 'note')}\n\nBottom line: target Allen.`;
    expect(stripUiTags(text, [player])).toBe('Bottom line: target Allen.');
  });
});

describe('renderUiTagInstructions', () => {
  it('teaches the tag: Markdoc form, attributes, required marker', () => {
    const txt = renderUiTagInstructions([player]);
    expect(txt).toContain('{% player');
    expect(txt).toContain('{% /player %}');
    expect(txt).toContain('id (required)');
    expect(txt).toContain('a player card in a ranking');
  });

  it('is empty when there are no tags', () => {
    expect(renderUiTagInstructions([])).toBe('');
  });
});
