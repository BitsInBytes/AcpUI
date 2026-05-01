import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import ChatInput from '../components/ChatInput/ChatInput';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useInputStore } from '../store/useInputStore';
import { useChatStore } from '../store/useChatStore';
import { useUIStore } from '../store/useUIStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { useCanvasStore } from '../store/useCanvasStore';

// Mock hooks
const mockHandleFileUpload = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useFileUpload', () => ({
  useFileUpload: () => ({
    attachments: [],
    setAttachments: vi.fn(),
    handleFileUpload: mockHandleFileUpload
  })
}));

vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({
    startRecording: vi.fn(),
    stopRecording: vi.fn()
  })
}));

describe('ChatInput Unit Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    act(() => {
      useSystemStore.setState({
        socket: {} as any,
        connected: true,
        isEngineReady: true,
        branding: {
          ...useSystemStore.getState().branding,
          models: {
            default: 'test-balanced',
            quickAccess: [
              { id: 'test-flagship', displayName: 'Flagship', description: 'Highest capability' },
              { id: 'test-balanced', displayName: 'Balanced', description: 'Everyday work' },
              { id: 'test-fast', displayName: 'Fast', description: 'Fast responses' }
            ]
          }
        },
        slashCommands: [
          { name: '/save', description: 'Save session', meta: {} },
          { name: '/settings', description: 'Open settings', meta: {} },
          { name: '/context', description: 'Add context', meta: { hint: 'path' } },
          { name: '/usage', description: 'Show usage', meta: {} },
        ],
        customCommands: []
      });

      useVoiceStore.setState({
        isRecording: false,
        isProcessingVoice: false,
        isVoiceEnabled: true,
      });

      useSessionLifecycleStore.setState({ 
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'test-balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
        activeSessionId: 's1',
        sessionNotes: {}
      });
      
      useInputStore.setState({
        inputs: { s1: '' },
        attachmentsMap: { s1: [] }
      });

      useUIStore.setState({
        isModelDropdownOpen: false,
        setModelDropdownOpen: (open: boolean) => useUIStore.setState({ isModelDropdownOpen: open })
      });
      
      useCanvasStore.setState({ terminals: [], isCanvasOpen: false });
    });
  });

  it('automatically focuses the textarea when enabled', () => {
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    expect(textarea).toHaveFocus();
  });

  it('does NOT focus the textarea when disabled (e.g. warming up)', () => {
    act(() => {
      useSessionLifecycleStore.setState({ 
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'test-balanced', isTyping: false, isWarmingUp: true, acpSessionId: null }]
      });
    });

    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Resuming/i);
    expect(textarea).not.toHaveFocus();
  });

  it('renders model selector and allows model change', () => {
    const handleModelChange = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleActiveSessionModelChange: handleModelChange });
    });

    render(<ChatInput />);
    
    // Check initial model
    expect(screen.getByText(/Balanced/i)).toBeInTheDocument();
    
    // Toggle dropdown
    const modelBtn = screen.getByText(/Balanced/i);
    act(() => {
      modelBtn.click();
    });

    // Select Flagship
    const proBtn = screen.getByText(/Flagship/i);
    act(() => {
      proBtn.click();
    });

    expect(handleModelChange).toHaveBeenCalledWith(expect.anything(), 'test-flagship');
  });

  it('submits on Enter key press', () => {
    const handleSubmit = vi.fn();
    act(() => {
      useChatStore.setState({ handleSubmit });
    });

    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    
    act(() => {
      fireEvent.change(textarea, { target: { value: 'test message' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    expect(handleSubmit).toHaveBeenCalled();
  });

  it('shows slash command dropdown when input starts with /', () => {
    act(() => { useInputStore.getState().setInput('s1', '/'); });
    render(<ChatInput />);
    expect(screen.getByText('/save')).toBeInTheDocument();
  });

  it('selecting a slash command fills the input', () => {
    const setInput = vi.fn();
    act(() => {
      useInputStore.setState({ inputs: { s1: '/' }, setInput });
    });
    render(<ChatInput />);
    fireEvent.mouseDown(screen.getByText('/context'));
    expect(setInput).toHaveBeenCalledWith('s1', '/context ');
  });

  it('send button is disabled when input is empty', () => {
    render(<ChatInput />);
    const sendBtn = screen.getByTitle('Send message');
    expect(sendBtn).toBeDisabled();
  });

  it('shows cancel button when session isTyping', () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ id: 's1', name: 'Test', messages: [], model: 'test-balanced', isTyping: true, isWarmingUp: false, acpSessionId: null }], });
    });
    render(<ChatInput />);
    expect(screen.getByTitle('Stop generating')).toBeInTheDocument();
  });

  it('uses provider-specific input placeholder when session has a provider', () => {
    act(() => {
      useSystemStore.setState(state => ({
        providersById: {
          ...state.providersById,
          'test-provider': {
            providerId: 'test-provider',
            label: 'Test Provider',
            default: false,
            ready: true,
            branding: {
              providerId: 'test-provider',
              assistantName: 'Assistant',
              busyText: 'Working...',
              emptyChatMessage: 'Send a message to start.',
              notificationTitle: 'ACP UI',
              appHeader: 'ACP UI',
              sessionLabel: 'Session',
              modelLabel: 'Model',
              inputPlaceholder: 'Provider-specific placeholder...',
            },
          },
        },
      }));
      useSessionLifecycleStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'test-balanced', isTyping: false, isWarmingUp: false, acpSessionId: null, provider: 'test-provider' }] as any,
        activeSessionId: 's1',
      });
    });

    render(<ChatInput />);
    expect(screen.getByPlaceholderText('Provider-specific placeholder...')).toBeInTheDocument();
  });
});
