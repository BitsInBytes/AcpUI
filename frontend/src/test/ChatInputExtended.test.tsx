import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ChatInput from '../components/ChatInput/ChatInput';
import { useInputStore } from '../store/useInputStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { useChatStore } from '../store/useChatStore';

describe('ChatInput Component', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: true };
    
    act(() => {
      useSystemStore.setState({ 
        socket: mockSocket, 
        connected: true,
        isEngineReady: true,
        activeProviderId: 'p1', 
        slashCommands: [{ name: '/help', description: 'Help' }],
        branding: { inputPlaceholder: 'Send a message...' }
      } as any);
      useSessionLifecycleStore.setState({ 
        activeSessionId: 's1',
        sessions: [{ id: 's1', isTyping: false, isWarmingUp: false, model: 'balanced', acpSessionId: 'a1' } as any]
      });
      useInputStore.setState({ inputs: { s1: '' }, attachmentsMap: { s1: [] } });
    });
  });

  it('renders textarea and updates store on change', () => {
    render(<ChatInput />);
    // Default placeholder when no session-specific branding is found
    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    expect(useInputStore.getState().inputs['s1']).toBe('hello');
  });

  it('triggers handleSubmit on Enter (without shift)', () => {
    const handleSubmit = vi.fn();
    act(() => {
       useChatStore.setState({ handleSubmit });
       useInputStore.setState({ inputs: { s1: 'submit me' } });
    });

    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(handleSubmit).toHaveBeenCalled();
  });

  it('shows slash command dropdown when typing /', async () => {
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText('Send a message...');
    
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '/' } });
    });

    expect(screen.getByText('Help')).toBeInTheDocument();
  });

  it('handles file upload trigger', () => {
     render(<ChatInput />);
     const uploadBtn = screen.getByTitle('Attach files');
     expect(uploadBtn).toBeInTheDocument();
  });
});
