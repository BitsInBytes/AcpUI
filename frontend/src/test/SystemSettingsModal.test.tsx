import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import SystemSettingsModal from '../components/SystemSettingsModal';
import { useSystemStore } from '../store/useSystemStore';
import { useUIStore } from '../store/useUIStore';
import { useVoiceStore } from '../store/useVoiceStore';

describe('SystemSettingsModal', () => {
  const mockSocket = {
    emit: vi.fn((event: string, ...args: any[]) => {
      // Simulate get_env callback
      if (event === 'get_env') {
        const cb = args[0];
        cb({ vars: { BACKEND_PORT: '3005', VOICE_STT_ENABLED: 'true', AGENT_NAME: 'agent-dev' } });
      }
      if (event === 'get_workspaces_config') {
        const cb = args[0];
        cb({ content: '{"workspaces":[]}' });
      }
      if (event === 'get_commands_config') {
        const cb = args[0];
        cb({ content: '{"commands":[{"name":"/test","description":"Test cmd","prompt":"do test"}]}' });
      }
      if (event === 'update_env') {
        const cb = args[1];
        cb?.({ success: true });
      }
    }),
    on: vi.fn(),
    off: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any });
      useUIStore.setState({ isSystemSettingsOpen: true });
      useVoiceStore.setState({
        availableAudioDevices: [{ id: 'mic1', label: 'Test Mic' }],
        selectedAudioDevice: '',
        fetchAudioDevices: vi.fn()
      });
    });
  });

  it('renders when open', () => {
    render(<SystemSettingsModal />);
    expect(screen.getByText('System Settings')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    act(() => { useUIStore.setState({ isSystemSettingsOpen: false }); });
    const { container } = render(<SystemSettingsModal />);
    expect(container.innerHTML).toBe('');
  });

  it('shows Audio tab by default with device selector', () => {
    render(<SystemSettingsModal />);
    expect(screen.getByText('Audio Input')).toBeInTheDocument();
    expect(screen.getByText('Test Mic')).toBeInTheDocument();
  });

  it('switches to Environment tab and shows env vars', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Environment'));
    expect(await screen.findByDisplayValue('3005')).toBeInTheDocument();
    expect(screen.getByDisplayValue('agent-dev')).toBeInTheDocument();
  });

  it('updates env var on blur', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Environment'));
    const input = await screen.findByDisplayValue('3005');
    fireEvent.change(input, { target: { value: '4000' } });
    fireEvent.blur(input);
    expect(mockSocket.emit).toHaveBeenCalledWith('update_env', { key: 'BACKEND_PORT', value: '4000' });
  });

  it('closes on Done button', () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Done'));
    expect(useUIStore.getState().isSystemSettingsOpen).toBe(false);
  });

  it('renders Workspaces tab button', () => {
    render(<SystemSettingsModal />);
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
  });

  it('clicking Workspaces tab shows workspace editor', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Workspaces'));
    expect(await screen.findByText('Workspace Configuration')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });
});


describe('SystemSettingsModal - Commands tab', () => {
  const mockSocket = {
    emit: vi.fn((event: string, ...args: any[]) => {
      if (event === 'get_env') args[0]({ vars: { PORT: '3005' } });
      if (event === 'get_workspaces_config') args[0]({ content: '{"workspaces":[]}' });
      if (event === 'get_commands_config') args[0]({ content: '{"commands":[{"name":"/cp","description":"Commit"}]}' });
    }),
    on: vi.fn(),
    off: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any });
      useUIStore.setState({ isSystemSettingsOpen: true });
      useVoiceStore.setState({ availableAudioDevices: [], selectedAudioDevice: '', fetchAudioDevices: vi.fn() });
    });
  });

  it('renders Commands tab button', () => {
    render(<SystemSettingsModal />);
    expect(screen.getByText('Commands')).toBeInTheDocument();
  });

  it('clicking Commands tab shows commands editor with content', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Commands'));
    expect(await screen.findByText('Custom Commands')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });
});

describe('SystemSettingsModal - boolean toggles', () => {
  const mockSocket = {
    emit: vi.fn((event: string, ...args: any[]) => {
      if (event === 'get_env') args[0]({ vars: { NOTIFICATION_SOUND: 'false', NOTIFICATION_DESKTOP: 'true', BACKEND_PORT: '3005' } });
      if (event === 'get_workspaces_config') args[0]({ content: '{"workspaces":[]}' });
      if (event === 'get_commands_config') args[0]({ content: '{"commands":[]}' });
      if (event === 'update_env') args[1]?.({ success: true });
    }),
    on: vi.fn(),
    off: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any });
      useUIStore.setState({ isSystemSettingsOpen: true });
      useVoiceStore.setState({ availableAudioDevices: [], selectedAudioDevice: '', fetchAudioDevices: vi.fn() });
    });
  });

  it('renders toggle switches for boolean env vars', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Environment'));
    const toggles = await screen.findAllByRole('button', { name: '' });
    const envToggles = toggles.filter(b => b.classList.contains('env-toggle'));
    expect(envToggles.length).toBe(2);
  });

  it('boolean toggles appear before text inputs', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Environment'));
    await screen.findByText('NOTIFICATION SOUND');
    const rows = document.querySelectorAll('.env-row');
    // First two should be toggles, last should be text
    expect(rows[0].classList.contains('env-row-toggle')).toBe(true);
    expect(rows[1].classList.contains('env-row-toggle')).toBe(true);
    expect(rows[2].classList.contains('env-row-toggle')).toBe(false);
  });

  it('clicking a toggle emits update_env with flipped value', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Environment'));
    await screen.findByText('NOTIFICATION SOUND');
    const toggles = document.querySelectorAll('.env-toggle');
    // NOTIFICATION_DESKTOP is 'true', click should flip to 'false'
    fireEvent.click(toggles[0]);
    expect(mockSocket.emit).toHaveBeenCalledWith('update_env', { key: 'NOTIFICATION_DESKTOP', value: 'false' });
  });
});

describe('SystemSettingsModal - Provider tab', () => {
  const mockSocket = {
    emit: vi.fn((event: string, ...args: any[]) => {
      if (event === 'get_env') args[0]({ vars: { PORT: '3005' } });
      if (event === 'get_workspaces_config') args[0]({ content: '{"workspaces":[]}' });
      if (event === 'get_commands_config') args[0]({ content: '{"commands":[]}' });
      if (event === 'get_provider_config') args[0]({ content: '{"apiKey":"test-key"}' });
    }),
    on: vi.fn(),
    off: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any });
      useUIStore.setState({ isSystemSettingsOpen: true });
      useVoiceStore.setState({ availableAudioDevices: [], selectedAudioDevice: '', fetchAudioDevices: vi.fn() });
    });
  });

  it('renders Provider tab button', () => {
    render(<SystemSettingsModal />);
    expect(screen.getByText('Provider')).toBeInTheDocument();
  });

  it('clicking Provider tab shows provider editor with user.json content', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Provider'));
    expect(await screen.findByText('Provider Settings')).toBeInTheDocument();
    expect(screen.getByText(/Edit user\.json/i)).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });
});
