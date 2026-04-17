import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { renderToolOutput } from '../components/renderToolOutput';

const components = {};

describe('renderToolOutput', () => {
  it('shows fallback for undefined output', () => {
    const { container } = render(<>{renderToolOutput(undefined, components)}</>);
    expect(container.textContent).toBe('No output or error details provided.');
  });

  it('shows fallback for empty string', () => {
    const { container } = render(<>{renderToolOutput('', components)}</>);
    expect(container.textContent).toBe('No output or error details provided.');
  });

  it('renders plain text in a pre element', () => {
    const { container } = render(<>{renderToolOutput('hello world', components)}</>);
    const pre = container.querySelector('pre.tool-output-pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('hello world');
  });

  it('strips ANSI codes from plain text', () => {
    const { container } = render(<>{renderToolOutput('\u001b[32m✓\u001b[39m test passed', components)}</>);
    expect(container.textContent).toBe('✓ test passed');
  });

  it('extracts stdout from JSON shell output', () => {
    const json = JSON.stringify({ exit_status: 'exit status: 0', stdout: 'hello\n', stderr: '' });
    const { container } = render(<>{renderToolOutput(json, components)}</>);
    expect(container.textContent).toBe('hello');
  });

  it('extracts stderr from JSON shell output', () => {
    const json = JSON.stringify({ exit_status: 'exit status: 1', stdout: '', stderr: 'error occurred' });
    const { container } = render(<>{renderToolOutput(json, components)}</>);
    expect(container.textContent).toBe('error occurred');
  });

  it('combines stdout and stderr', () => {
    const json = JSON.stringify({ exit_status: 'exit status: 0', stdout: 'out', stderr: 'warn' });
    const { container } = render(<>{renderToolOutput(json, components)}</>);
    expect(container.textContent).toContain('out');
    expect(container.textContent).toContain('warn');
  });

  it('strips ANSI from shell JSON output', () => {
    const json = JSON.stringify({ exit_status: 'exit status: 0', stdout: '\u001b[32m✓\u001b[39m passed', stderr: '' });
    const { container } = render(<>{renderToolOutput(json, components)}</>);
    expect(container.textContent).toBe('✓ passed');
  });

  it('shows (no output) for empty shell JSON', () => {
    const json = JSON.stringify({ exit_status: 'exit status: 0', stdout: '', stderr: '' });
    const { container } = render(<>{renderToolOutput(json, components)}</>);
    expect(container.textContent).toBe('(no output)');
  });

  it('renders diff with content lines as diff-output', () => {
    const diff = 'Index: file.txt\n===\n--- old\n+++ new\n@@ -1 +1 @@\n-old line\n+new line';
    const { container } = render(<>{renderToolOutput(diff, components)}</>);
    expect(container.querySelector('.diff-output')).not.toBeNull();
    expect(container.querySelector('.diff-add')?.textContent).toBe('+new line');
    expect(container.querySelector('.diff-remove')?.textContent).toBe('-old line');
  });

  it('falls through to pre for diff with only headers (empty create)', () => {
    const diff = 'Index: file.txt\n===\n--- file.txt\told\n+++ file.txt\tnew';
    const { container } = render(<>{renderToolOutput(diff, components)}</>);
    expect(container.querySelector('.diff-output')).toBeNull();
    expect(container.querySelector('pre.tool-output-pre')).not.toBeNull();
  });

  it('does not treat non-JSON curly brace text as shell output', () => {
    const { container } = render(<>{renderToolOutput('{not json}', components)}</>);
    expect(container.textContent).toBe('{not json}');
  });

  it('renders SyntaxHighlighter for file read with filePath', () => {
    const { container } = render(<>{renderToolOutput('const x = 1;', components, 'test.js')}</>);
    expect(container.querySelector('.syntax-highlighter')).not.toBeNull();
  });

  it('renders SyntaxHighlighter for create-only diff with filePath', () => {
    const diff = 'Index: file.ts\n===\n--- old\n+++ new\n@@ -0,0 +1,2 @@\n+line one\n+line two';
    const { container } = render(<>{renderToolOutput(diff, components, 'file.ts')}</>);
    expect(container.querySelector('.syntax-highlighter')).not.toBeNull();
    expect(container.querySelector('.diff-output')).toBeNull();
  });

  it('renders create-only diff without filePath as diff', () => {
    const diff = 'Index: file.ts\n===\n--- old\n+++ new\n@@ -0,0 +1,2 @@\n+line one\n+line two';
    const { container } = render(<>{renderToolOutput(diff, components)}</>);
    expect(container.querySelector('.diff-output')).not.toBeNull();
  });

  it('maps file extensions to correct languages', () => {
    const cases = [
      { ext: 'test.js', lang: 'javascript' },
      { ext: 'test.cs', lang: 'csharp' },
      { ext: 'test.py', lang: 'python' },
    ];
    for (const { ext, lang } of cases) {
      const { container } = render(<>{renderToolOutput('code', components, ext)}</>);
      const highlighter = container.querySelector('.syntax-highlighter code');
      expect(highlighter?.className).toContain(`language-${lang}`);
    }
  });

  it('trims output whitespace', () => {
    const { container } = render(<>{renderToolOutput('  hello  ', components)}</>);
    expect(container.querySelector('pre.tool-output-pre')!.textContent).toBe('  hello  ');
    // With filePath, output preserves whitespace for proper indentation
    const { container: c2 } = render(<>{renderToolOutput('  hello  ', components, 'test.txt')}</>);
    expect(c2.textContent).toBe('  hello  ');
  });

  it('does NOT syntax-highlight shell JSON output even with filePath', () => {
    const json = JSON.stringify({ exit_status: 'exit status: 0', stdout: 'hello\n', stderr: '' });
    const { container } = render(<>{renderToolOutput(json, components, 'test.js')}</>);
    expect(container.querySelector('.syntax-highlighter')).toBeNull();
    expect(container.querySelector('pre.tool-output-pre')).not.toBeNull();
  });
});


describe('renderToolOutput – JSON pretty-printing', () => {
  it('pretty-prints JSON object with syntax highlighting', () => {
    const json = JSON.stringify({ name: 'test', value: 42 });
    const { container } = render(<>{renderToolOutput(json, components)}</>);
    expect(container.querySelector('.syntax-highlighter')).not.toBeNull();
    expect(container.textContent).toContain('"name": "test"');
  });

  it('pretty-prints JSON array with syntax highlighting', () => {
    const json = JSON.stringify([1, 2, 3]);
    const { container } = render(<>{renderToolOutput(json, components)}</>);
    expect(container.querySelector('.syntax-highlighter')).not.toBeNull();
    expect(container.textContent).toContain('1');
  });

  it('falls through to plain pre for invalid JSON starting with {', () => {
    const { container } = render(<>{renderToolOutput('{invalid json here', components)}</>);
    expect(container.querySelector('.syntax-highlighter')).toBeNull();
    expect(container.querySelector('pre.tool-output-pre')).not.toBeNull();
    expect(container.textContent).toBe('{invalid json here');
  });

  it('does NOT pretty-print shell JSON output (shell extraction takes priority)', () => {
    const json = JSON.stringify({ exit_status: 'exit status: 0', stdout: '{"nested":"json"}', stderr: '' });
    const { container } = render(<>{renderToolOutput(json, components)}</>);
    expect(container.querySelector('.syntax-highlighter')).toBeNull();
    expect(container.querySelector('pre.tool-output-pre')).not.toBeNull();
    expect(container.textContent).toBe('{"nested":"json"}');
  });
});