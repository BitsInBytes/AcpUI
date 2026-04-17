import { describe, it, expect } from 'vitest';
import { renderToolOutput } from '../components/renderToolOutput';

describe('renderToolOutput - ANSI color rendering', () => {
  const mc = {};

  it('renders ANSI colored output as HTML with color spans', () => {
    const output = '\x1b[32mgreen text\x1b[0m normal';
    const result = renderToolOutput(output, mc);
    // Should return a pre with dangerouslySetInnerHTML (ANSI path)
    expect(result).toBeDefined();
    // @ts-expect-error - checking props
    const props = result?.props;
    expect(props?.dangerouslySetInnerHTML?.__html).toContain('green text');
    expect(props?.className).toContain('ansi-output');
  });

  it('strips terminal noise (cursor, window title) but keeps colors', () => {
    const output = '\x1b[?25l\x1b]0;title\x07\x1b[31mred\x1b[0m';
    const result = renderToolOutput(output, mc);
    // @ts-expect-error - checking props
    const html = result?.props?.dangerouslySetInnerHTML?.__html;
    expect(html).toContain('red');
    expect(html).not.toContain('?25l');
    expect(html).not.toContain('title');
  });

  it('does not use ANSI path for plain text', () => {
    const output = 'just plain text';
    const result = renderToolOutput(output, mc);
    // @ts-expect-error - checking props
    expect(result?.props?.className).toBe('tool-output-pre');
    // @ts-expect-error - checking props
    expect(result?.props?.dangerouslySetInnerHTML).toBeUndefined();
  });

  it('does not use ANSI path for shell JSON output', () => {
    const output = '{"stdout":"hello","stderr":""}';
    const result = renderToolOutput(output, mc);
    // Should be plain pre (shell extraction), not ANSI
    // @ts-expect-error - checking props
    expect(result?.props?.dangerouslySetInnerHTML).toBeUndefined();
  });
});
