import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChatMessage from '../components/ChatMessage';
import type { Message } from '../types';

// Mock remark-gfm
vi.mock('remark-gfm', () => ({ default: () => {} }));

describe('ChatMessage Diff Rendering', () => {
  it('renders a unified diff with correct CSS classes in the unified timeline', () => {
    const diffOutput = `Index: test.js
===================================================================
--- old
+++ new
@@ -1,3 +1,3 @@
-console.log("old");
+console.log("new");
  const x = 1;`;

    const assistantMessage: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'I updated the file.',
      timeline: [
        { 
          type: 'tool', 
          event: { 
            id: 't1', 
            title: 'Running replace: test.js', 
            status: 'completed', 
            output: diffOutput 
          },
          isCollapsed: false
        }
      ]
    };

    render(<ChatMessage message={assistantMessage} />);

    // Verify tool title
    expect(screen.getByText('Running replace: test.js')).toBeInTheDocument();

    // Verify diff lines and classes
    expect(screen.getByText('Index: test.js')).toHaveClass('diff-header');
    expect(screen.getByText('-console.log("old");')).toHaveClass('diff-remove');
    expect(screen.getByText('+console.log("new");')).toHaveClass('diff-add');
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toHaveClass('diff-header');
  });
});
