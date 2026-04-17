import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import ChatInput from '../components/ChatInput/ChatInput';
import { useSystemStore } from '../store/useSystemStore';
import { useChatStore } from '../store/useChatStore';
import { useUIStore } from '../store/useUIStore';
import { useVoiceStore } from '../store/useVoiceStore';

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
        slashCommands: [
          { name: '/save', description: 'Save session', meta: {} },
          { name: '/settings', description: 'Open settings', meta: {} },
          { name: '/context', description: 'Add context', meta: { hint: 'path' } },
          { name: '/usage', description: 'Show usage', meta: {} },
        ],
      });

      useVoiceStore.setState({
        isRecording: false,
        isProcessingVoice: false,
        isVoiceEnabled: true,
      });

      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
        activeSessionId: 's1',
        inputs: { s1: '' },
        attachmentsMap: { s1: [] },
        setInput: vi.fn(),
        handleSubmit: vi.fn(),
        handleCancel: vi.fn(),
        handleSaveSession: vi.fn(),
        handleActiveSessionModelChange: vi.fn()
      });

      useUIStore.setState({
        isModelDropdownOpen: false,
        setModelDropdownOpen: (open: boolean) => useUIStore.setState({ isModelDropdownOpen: open })
      });
    });
  });

  it('automatically focuses the textarea when enabled', () => {
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    expect(textarea).toHaveFocus();
  });

  it('does NOT focus the textarea when disabled (e.g. warming up)', () => {
    act(() => {
      useSystemStore.setState({ isEngineReady: false });
    });

    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/warming up/i);
    expect(textarea).not.toHaveFocus();
  });

  it('renders model selector and allows model change', () => {
    const handleModelChange = vi.fn();
    act(() => {
      useChatStore.setState({ handleActiveSessionModelChange: handleModelChange });
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

    expect(handleModelChange).toHaveBeenCalledWith(expect.anything(), 'flagship');
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

  it('renders mic button when isVoiceEnabled is true, hides when false', () => {
    const { unmount } = render(<ChatInput />);
    expect(screen.getByTitle('Start voice input')).toBeInTheDocument();
    unmount();

    act(() => { useVoiceStore.setState({ isVoiceEnabled: false }); });
    render(<ChatInput />);
    expect(screen.queryByTitle('Start voice input')).not.toBeInTheDocument();
  });

  it('shows slash command dropdown when input starts with /', () => {
    act(() => { useChatStore.setState({ inputs: { s1: '/' } }); });
    render(<ChatInput />);
    // /save, /settings, /context visible; /usage is hidden
    expect(screen.getByText('/save')).toBeInTheDocument();
    expect(screen.getByText('/settings')).toBeInTheDocument();
    expect(screen.getByText('/context')).toBeInTheDocument();
    expect(screen.queryByText('/usage')).not.toBeInTheDocument();
  });

  it('filters slash commands as user types', () => {
    act(() => { useChatStore.setState({ inputs: { s1: '/sa' } }); });
    render(<ChatInput />);
    expect(screen.getByText('/save')).toBeInTheDocument();
    expect(screen.queryByText('/settings')).not.toBeInTheDocument();
  });

  it('selecting a slash command fills the input', () => {
    const setInput = vi.fn();
    act(() => {
      useChatStore.setState({ inputs: { s1: '/' }, setInput });
    });
    render(<ChatInput />);
    // /context has a hint so it should fill input with "/context "
    fireEvent.mouseDown(screen.getByText('/context'));
    expect(setInput).toHaveBeenCalledWith('s1', '/context ');
  });

  it('paste handler passes paths through unchanged', () => {
    const setInput = vi.fn();
    act(() => { useChatStore.setState({ setInput }); });
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Send a message/i);

    fireEvent.paste(textarea, {
      clipboardData: { getData: () => 'C:\\repos\\project\\file.ts', items: [] }
    });

    // No conversion — Windows paths pass through as-is
    expect(setInput).not.toHaveBeenCalled();
  });

  it('paste does NOT convert URLs like https://example.com', () => {
    const setInput = vi.fn();
    act(() => { useChatStore.setState({ setInput }); });
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Send a message/i);

    fireEvent.paste(textarea, {
      clipboardData: { getData: () => 'https://example.com/path', items: [] }
    });

    // URL has no Windows drive letter pattern, so setInput should NOT be called by paste handler
    expect(setInput).not.toHaveBeenCalled();
  });

  it('send button is disabled when input is empty', () => {
    render(<ChatInput />);
    const sendBtn = screen.getByTitle('Send message');
    expect(sendBtn).toBeDisabled();
  });

  it('shows cancel button when session isTyping', () => {
    act(() => {
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: true, isWarmingUp: false, acpSessionId: null }],
      });
    });
    render(<ChatInput />);
    expect(screen.getByTitle('Stop generating')).toBeInTheDocument();
    expect(screen.queryByTitle('Send message')).not.toBeInTheDocument();
  });

  it('Escape key in slash dropdown clears input', () => {
    const setInput = vi.fn();
    act(() => {
      useChatStore.setState({ inputs: { s1: '/sa' }, setInput });
    });
    render(<ChatInput />);
    expect(screen.getByText('/save')).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/Send a message/i);
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(setInput).toHaveBeenCalledWith('s1', '');
  });

  it('Arrow down/up navigates slash dropdown items', () => {
    act(() => {
      useChatStore.setState({ inputs: { s1: '/' } });
    });
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Send a message/i);

    // Arrow down highlights first, then second item
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    const items = document.querySelectorAll('.slash-item');
    expect(items[0]).toHaveClass('active');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(items[1]).toHaveClass('active');
    expect(items[0]).not.toHaveClass('active');

    // Arrow up goes back
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(items[0]).toHaveClass('active');
  });

  it('renders context progress bar with correct color based on percentage', () => {
    const cases = [
      { pct: 30, color: 'rgba(96, 165, 250, 0.5)' },
      { pct: 55, color: 'rgb(34, 197, 94)' },
      { pct: 65, color: 'rgb(234, 179, 8)' },
      { pct: 85, color: 'rgb(220, 38, 38)' },
    ];
    for (const { pct, color } of cases) {
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'acp-1' }],
        });
        useSystemStore.setState({ contextUsageBySession: { 'acp-1': pct } });
      });
      const { container, unmount } = render(<ChatInput />);
      const fill = container.querySelector('.context-bar-fill') as HTMLElement;
      expect(fill.style.width).toBe(`${pct}%`);
      expect(fill.style.backgroundColor).toBe(color);
      unmount();
    }
  });

  
});


import { useCanvasStore } from '../store/useCanvasStore';

describe('ChatInput - Terminal Pill', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    act(() => {
      useSystemStore.setState({
        socket: {} as any,
        connected: true,
        isEngineReady: true,
        slashCommands: [],
      });
      useVoiceStore.setState({ isRecording: false, isProcessingVoice: false, isVoiceEnabled: false });
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
        activeSessionId: 's1',
        inputs: { s1: '' },
        attachmentsMap: { s1: [] },
        setInput: vi.fn(),
        handleSubmit: vi.fn(),
        handleCancel: vi.fn(),
        handleSaveSession: vi.fn(),
        handleActiveSessionModelChange: vi.fn(),
      });
      useCanvasStore.setState({ terminals: [], openTerminal: vi.fn(), closeTerminal: vi.fn() });
    });
  });

  it('renders terminal pill button with text Terminal', () => {
    render(<ChatInput />);
    expect(screen.getByText('Terminal')).toBeInTheDocument();
  });

  it('terminal pill has active class when terminals exist', () => {
    act(() => { useCanvasStore.setState({ terminals: [{ id: 't1', label: 'Terminal 1', sessionId: 's1' }] }); });
    render(<ChatInput />);
    const pill = screen.getByText('Terminal').closest('button');
    expect(pill?.className).toContain('active');
  });

  it('clicking pill when terminal is closed calls openTerminal', () => {
    const openTerminal = vi.fn();
    act(() => { useCanvasStore.setState({ terminals: [], openTerminal }); });
    render(<ChatInput />);
    fireEvent.click(screen.getByText('Terminal'));
    expect(openTerminal).toHaveBeenCalled();
  });
});



describe('ChatInput - Canvas Pill', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    act(() => {
      useSystemStore.setState({
        socket: {} as any,
        connected: true,
        isEngineReady: true,
        slashCommands: [],
      });
      useVoiceStore.setState({ isRecording: false, isProcessingVoice: false, isVoiceEnabled: false });
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
        activeSessionId: 's1',
        inputs: { s1: '' },
        attachmentsMap: { s1: [] },
        setInput: vi.fn(),
        handleSubmit: vi.fn(),
        handleCancel: vi.fn(),
        handleSaveSession: vi.fn(),
        handleActiveSessionModelChange: vi.fn(),
      });
      useCanvasStore.setState({ isCanvasOpen: false, terminals: [], openTerminal: vi.fn(), closeTerminal: vi.fn(), setIsCanvasOpen: vi.fn() });
    });
  });

  it('renders canvas pill button with text Canvas', () => {
    render(<ChatInput />);
    expect(screen.getByText('Canvas')).toBeInTheDocument();
  });

  it('canvas pill has active class when isCanvasOpen is true and terminals is empty', () => {
    act(() => { useCanvasStore.setState({ isCanvasOpen: true, terminals: [] }); });
    render(<ChatInput />);
    const pill = screen.getByText('Canvas').closest('button');
    expect(pill?.className).toContain('active');
  });
});


describe('ChatInput - Canvas & Terminal Pills (multi-terminal)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    act(() => {
      useSystemStore.setState({
        socket: {} as any,
        connected: true,
        isEngineReady: true,
        slashCommands: [],
      });
      useVoiceStore.setState({ isRecording: false, isProcessingVoice: false, isVoiceEnabled: false });
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
        activeSessionId: 's1',
        inputs: { s1: '' },
        attachmentsMap: { s1: [] },
        setInput: vi.fn(),
        handleSubmit: vi.fn(),
        handleCancel: vi.fn(),
        handleSaveSession: vi.fn(),
        handleActiveSessionModelChange: vi.fn(),
      });
      useCanvasStore.setState({ terminals: [], activeTerminalId: null, isCanvasOpen: false, canvasOpenBySession: {}, canvasArtifacts: [], activeCanvasArtifact: null, openTerminal: vi.fn(), closeTerminal: vi.fn(), setIsCanvasOpen: vi.fn() });
    });
  });

  it('canvas pill has active class when isCanvasOpen is true regardless of terminals', () => {
    act(() => { useCanvasStore.setState({ isCanvasOpen: true, terminals: [{ id: 't1', label: 'Terminal 1', sessionId: 's1' }] }); });
    render(<ChatInput />);
    const pill = screen.getByText('Canvas').closest('button');
    expect(pill?.className).toContain('active');
  });

  it('terminal pill has active class when session has terminals', () => {
    act(() => { useCanvasStore.setState({ terminals: [{ id: 't1', label: 'Terminal 1', sessionId: 's1' }] }); });
    render(<ChatInput />);
    const pill = screen.getByText('Terminal').closest('button');
    expect(pill?.className).toContain('active');
  });
});


describe('ChatInput - Merge Fork Pill', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    act(() => {
      useSystemStore.setState({
        socket: {} as any,
        connected: true,
        isEngineReady: true,
        slashCommands: [],
      });
      useVoiceStore.setState({ isRecording: false, isProcessingVoice: false, isVoiceEnabled: false });
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null, forkedFrom: 'parent-1' }],
        activeSessionId: 's1',
        inputs: { s1: '' },
        attachmentsMap: { s1: [] },
        setInput: vi.fn(),
        handleSubmit: vi.fn(),
        handleCancel: vi.fn(),
        handleSaveSession: vi.fn(),
        handleActiveSessionModelChange: vi.fn(),
      });
      useCanvasStore.setState({ terminals: [], isCanvasOpen: false, openTerminal: vi.fn(), closeTerminal: vi.fn(), setIsCanvasOpen: vi.fn() });
    });
  });

  it('renders Merge Fork pill when session has forkedFrom', () => {
    render(<ChatInput />);
    expect(screen.getByText('Merge Fork')).toBeInTheDocument();
    expect(screen.getByTitle('Summarize fork work and send to parent chat')).toBeInTheDocument();
  });

  it('does NOT render Merge Fork pill when session has no forkedFrom', () => {
    act(() => {
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
      });
    });
    render(<ChatInput />);
    expect(screen.queryByText('Merge Fork')).not.toBeInTheDocument();
  });

  it('does NOT render Merge Fork pill for sub-agent sessions', () => {
    act(() => {
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null, forkedFrom: 'parent-1', isSubAgent: true }],
      });
    });
    render(<ChatInput />);
    expect(screen.queryByText('Merge Fork')).not.toBeInTheDocument();
  });

  it('Merge Fork pill is disabled when session isTyping', () => {
    act(() => {
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: true, isWarmingUp: false, acpSessionId: null, forkedFrom: 'parent-1' }],
      });
    });
    render(<ChatInput />);
    const pill = screen.getByText('Merge Fork').closest('button');
    expect(pill).toBeDisabled();
  });
});