import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderToolOutput } from '../components/renderToolOutput';

describe('renderToolOutput', () => {
  it('renders simple text output', () => {
    const { container } = render(<>{renderToolOutput('hello', {})}</>);
    expect(container).toHaveTextContent('hello');
  });

  it('renders JSON output', () => {
    const json = { a: 1 };
    const { container } = render(<>{renderToolOutput(JSON.stringify(json), {})}</>);
    // Check text content instead of getByText to handle syntax highlighter fragmentation
    expect(container).toHaveTextContent(/"a": 1/);
  });

  it('handles empty or null output', () => {
    const { container } = render(<>{renderToolOutput('', {})}</>);
    expect(container).toHaveTextContent('No output or error details provided');
  });

  it('renders error block if present', () => {
      const output = ':::ERROR:::\nfail\n:::END_ERROR:::';
      const { container } = render(<>{renderToolOutput(output, {})}</>);
      expect(container).toHaveTextContent('fail');
  });

  it('renders structured web fetch output', () => {
    const output = JSON.stringify({
      type: 'web_fetch_result',
      url: 'https://example.test/docs',
      status: 200,
      contentType: 'text/html',
      title: 'Docs',
      text: 'Hello world'
    });

    const { container } = render(<>{renderToolOutput(output, {})}</>);

    expect(container.querySelector('.web-fetch-output')).not.toBeNull();
    expect(container).toHaveTextContent('Docs');
    expect(container).toHaveTextContent('https://example.test/docs');
    expect(container).toHaveTextContent('Status 200');
    expect(container).toHaveTextContent('Hello world');
  });

  it('renders structured grep search output', () => {
    const output = JSON.stringify({
      type: 'ux_grep_search_result',
      pattern: 'TODO',
      dirPath: 'D:/Git/AcpUI',
      matchCount: 1,
      matches: [{
        filePath: 'D:/Git/AcpUI/src/app.ts',
        lineNumber: 12,
        line: 'const value = "TODO";',
        submatches: [{ text: 'TODO', start: 15, end: 19 }]
      }]
    });

    const { container } = render(<>{renderToolOutput(output, {})}</>);

    expect(container.querySelector('.grep-output')).not.toBeNull();
    expect(container).toHaveTextContent('1 matches');
    expect(container).toHaveTextContent('D:/Git/AcpUI/src/app.ts');
    expect(container).toHaveTextContent('const value = "TODO";');
    expect(container.querySelector('.grep-match-highlight')).not.toBeNull();
  });
});
