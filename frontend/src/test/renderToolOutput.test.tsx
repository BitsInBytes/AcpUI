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
});
