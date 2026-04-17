import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HistoryList from '../components/HistoryList';

describe('HistoryList Component', () => {
  it('renders a list of chat messages', () => {
    const messages: any[] = [
      { id: '1', role: 'user', content: 'Message 1' },
      { id: '2', role: 'assistant', content: 'Message 2' }
    ];
    render(<HistoryList messages={messages} />);
    
    expect(screen.getByText('Message 1')).toBeInTheDocument();
    expect(screen.getByText('Message 2')).toBeInTheDocument();
  });

  it('renders nothing when messages are empty', () => {
    const { container } = render(<HistoryList messages={[]} />);
    expect(container.firstChild).toHaveClass('messages');
    expect(container.firstChild?.childNodes.length).toBe(0);
  });
});
