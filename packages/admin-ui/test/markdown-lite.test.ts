import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MarkdownLite, { parseBlocks } from '../src/components/MarkdownLite';

describe('MarkdownLite (connection setup help)', () => {
  it('splits paragraphs and lists', () => {
    expect(parseBlocks('Intro line\nstill intro\n\n1. one\n2. two\n\n- a\n- b')).toEqual([
      { kind: 'p', text: 'Intro line still intro' },
      { kind: 'ol', items: ['one', 'two'] },
      { kind: 'ul', items: ['a', 'b'] },
    ]);
  });

  it('renders bold, italic and code, and never raw HTML', () => {
    const source = 'Needs **Acme 25.04** at `/api/current`, see *Credentials*. <img src=x onerror=alert(1)>';
    const html = mount(MarkdownLite, { props: { source } }).html();
    expect(html).toContain('<strong>Acme 25.04</strong>');
    expect(html).toContain('<code>/api/current</code>');
    expect(html).toContain('<em>Credentials</em>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
