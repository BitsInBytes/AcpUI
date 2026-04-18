import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MemoizedMarkdown from '../components/MemoizedMarkdown';

vi.mock('react-markdown', () => ({
  default: ({ children }: any) => <div data-testid="md-block">{children}</div>
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

describe('MemoizedMarkdown', () => {
  it('renders markdown content', () => {
    render(<MemoizedMarkdown content="Hello world" isStreaming={false} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('memoizes completed blocks during streaming', () => {
    const content = 'Block one\n\nBlock two\n\nBlock three';
    const { container } = render(<MemoizedMarkdown content={content} isStreaming={true} />);
    const blocks = container.querySelectorAll('[data-testid="md-block"]');
    // 2 settled MemoizedBlocks + 1 active streaming block = 3
    expect(blocks.length).toBe(3);
    expect(screen.getByText('Block one')).toBeInTheDocument();
    expect(screen.getByText('Block three')).toBeInTheDocument();
  });

  it('renders full content when not streaming', () => {
    const content = 'First\n\nSecond';
    const { container } = render(<MemoizedMarkdown content={content} isStreaming={false} />);
    // Non-streaming renders as single ReactMarkdown block (not split)
    const blocks = container.querySelectorAll('[data-testid="md-block"]');
    expect(blocks.length).toBe(1);
    expect(blocks[0].textContent).toContain('First');
    expect(blocks[0].textContent).toContain('Second');
  });
});



describe('MemoizedMarkdown - additional', () => {
  it('when isStreaming=false, re-rendering with same content reuses the same DOM node', () => {
    const content = 'Stable content';
    const { container, rerender } = render(<MemoizedMarkdown content={content} isStreaming={false} />);
    const firstNode = container.querySelector('[data-testid="md-block"]')!;

    rerender(<MemoizedMarkdown content={content} isStreaming={false} />);
    const secondNode = container.querySelector('[data-testid="md-block"]')!;

    expect(firstNode).toBe(secondNode);
  });

  it('when isStreaming=true with multiple blocks, only the last block has streaming-block class', () => {
    const content = 'Block A\n\nBlock B\n\nBlock C';
    const { container } = render(<MemoizedMarkdown content={content} isStreaming={true} />);
    const streamingBlocks = container.querySelectorAll('.streaming-block');
    expect(streamingBlocks.length).toBe(1);
    expect(streamingBlocks[0].textContent).toContain('Block C');
  });
});