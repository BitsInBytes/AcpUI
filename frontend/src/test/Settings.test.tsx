import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { useSystemStore } from '../store/useSystemStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { useChatStore } from '../store/useChatStore';
import { useUIStore } from '../store/useUIStore';

describe('App Settings Modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    act(() => {
      useSystemStore.setState({
        socket: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any,
        connected: true,
        isEngineReady: true,
        branding: {
          ...useSystemStore.getState().branding,
          models: {
            default: 'balanced',
            flagship: { id: 'test-flagship', displayName: 'Flagship' },
            balanced: { id: 'test-balanced', displayName: 'Balanced' },
            fast: { id: 'test-fast', displayName: 'Fast' }
          }
        }
      });
      useVoiceStore.setState({
        isRecording: false,
        isProcessingVoice: false,
        availableAudioDevices: [{ deviceId: 'dev1', label: 'Mic 1', kind: 'audioinput' }] as any[],
        selectedAudioDevice: 'dev1',
        setSelectedAudioDevice: vi.fn()
      });
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Chat 1', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'acp-1' }],
        activeSessionId: 's1',
        inputs: { s1: '' },
        attachmentsMap: { s1: [] },
      });
      useUIStore.setState({ isSidebarOpen: false, isSettingsOpen: false, settingsSessionId: null, setSettingsOpen: vi.fn() });
    });

    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { deviceId: 'dev1', label: 'Mic 1', kind: 'audioinput' }
        ]),
        getUserMedia: vi.fn().mockResolvedValue({})
      },
      writable: true,
      configurable: true
    });
  });

  it('shows context usage when modal opens', async () => {
    await act(async () => {
      useUIStore.setState({ isSettingsOpen: true, settingsSessionId: 's1' });
      useSystemStore.setState({ contextUsageBySession: { 'acp-1': 5.5 } });
    });

    render(<App />);

    expect(await screen.findByText(/5.5% of context used/)).toBeInTheDocument();
  });

  it('handles model selection change', async () => {
    const handleSessionModelChange = vi.fn();
    await act(async () => {
      useChatStore.setState({ handleSessionModelChange });
      useUIStore.setState({ isSettingsOpen: true, settingsSessionId: 's1' });
    });

    render(<App />);

    fireEvent.click(screen.getByText('Config'));

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'flagship' } });

    expect(handleSessionModelChange).toHaveBeenCalledWith(expect.anything(), 's1', 'flagship');
  });

  it('handles session deletion with confirmation', async () => {
    const handleDeleteSession = vi.fn();
    const setSettingsOpen = vi.fn();
    await act(async () => {
      useChatStore.setState({ handleDeleteSession });
      useUIStore.setState({ isSettingsOpen: true, settingsSessionId: 's1', setSettingsOpen });
    });

    render(<App />);

    fireEvent.click(screen.getByText('Delete'));

    const deleteBtn = screen.getByText('Delete Chat');
    fireEvent.click(deleteBtn);

    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    
    const confirmBtn = screen.getByText('Yes, Delete');
    fireEvent.click(confirmBtn);

    expect(handleDeleteSession).toHaveBeenCalledWith(expect.anything(), 's1');
    expect(setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('cancel delete hides confirmation', async () => {
    await act(async () => {
      useUIStore.setState({ isSettingsOpen: true, settingsSessionId: 's1' });
    });
    render(<App />);
    const deleteTab = await screen.findByText('Delete');
    fireEvent.click(deleteTab);
    const deleteBtn = await screen.findByText('Delete Chat');
    fireEvent.click(deleteBtn);
    const cancelBtn = await screen.findByText('Cancel');
    fireEvent.click(cancelBtn);
    expect(screen.getByText('Delete Chat')).toBeInTheDocument();
  });
});
