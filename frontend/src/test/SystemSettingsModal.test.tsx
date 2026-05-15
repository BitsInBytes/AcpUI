import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SystemSettingsModal from '../components/SystemSettingsModal';
import { useUIStore } from '../store/useUIStore';
import { useSystemStore } from '../store/useSystemStore';
import { useVoiceStore } from '../store/useVoiceStore';

// Mock Monaco Editor
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: any) => (
    <textarea 
      data-testid="monaco-mock" 
      value={value} 
      onChange={(e) => onChange(e.target.value)} 
    />
  )
}));

describe('SystemSettingsModal', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = {
      emit: vi.fn((event, ...args) => {
        const callback = args[args.length - 1];
        if (typeof callback === 'function') {
           if (event === 'get_env') callback({ vars: { KEY1: 'val1', BOOL1: 'true' } });
           if (event === 'get_workspaces_config') callback({ content: '[]' });
           if (event === 'get_commands_config') callback({ content: '[]' });
           if (event === 'get_provider_config') callback({ content: '{}' });
           if (event === 'save_workspaces_config') callback({ success: true });
           if (event === 'save_commands_config') callback({ success: true });
           if (event === 'save_provider_config') callback({ success: true });
        }
      }),
      on: vi.fn(),
      off: vi.fn()
    };

    act(() => {
      useUIStore.setState({ isSystemSettingsOpen: true });
      useSystemStore.setState({ socket: mockSocket, defaultProviderId: 'p1' });
      useVoiceStore.setState({
        availableAudioDevices: [{ id: 'd1', label: 'Mic 1' }],
        selectedAudioDevice: 'd1'
      });
    });
  });

  it('renders and switches tabs', async () => {
    render(<SystemSettingsModal />);
    
    expect(screen.getByText('System Settings')).toBeInTheDocument();
    expect(screen.getByText('Audio Input')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Environment'));
    expect(screen.getByText('Environment Variables')).toBeInTheDocument();
    expect(screen.getByText('KEY1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Workspaces'));
    expect(screen.getByText('Workspace Configuration')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Commands'));
    expect(screen.getByText('Custom Commands')).toBeInTheDocument();
  });

  it('handles environment variable toggle', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Environment'));

    const toggle = screen.getByText('BOOL1').closest('.env-row')!.querySelector('.env-toggle');
    expect(toggle).toHaveClass('on');

    fireEvent.click(toggle!);
    expect(mockSocket.emit).toHaveBeenCalledWith('update_env', { key: 'BOOL1', value: 'false' });
  });

  it('handles environment variable input change', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Environment'));

    const input = screen.getByDisplayValue('val1');
    fireEvent.change(input, { target: { value: 'newval' } });
    fireEvent.blur(input);

    expect(mockSocket.emit).toHaveBeenCalledWith('update_env', { key: 'KEY1', value: 'newval' });
  });

  it('handles workspace config save', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Workspaces'));

    const editor = screen.getByTestId('monaco-mock');
    fireEvent.change(editor, { target: { value: '{"updated": true}' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockSocket.emit).toHaveBeenCalledWith('save_workspaces_config', expect.objectContaining({ content: '{"updated": true}' }), expect.any(Function));
    expect(screen.getByText('✓ Saved and workspace list refreshed')).toBeInTheDocument();
  });

  it('handles invalid JSON in workspace config', async () => {
    render(<SystemSettingsModal />);
    fireEvent.click(screen.getByText('Workspaces'));

    const editor = screen.getByTestId('monaco-mock');
    fireEvent.change(editor, { target: { value: '{invalid' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
  });

  it('closes when clicking close button', () => {
    const setOpen = vi.fn();
    act(() => { useUIStore.setState({ setSystemSettingsOpen: setOpen }); });
    
    const { container } = render(<SystemSettingsModal />);
    const closeBtn = container.querySelector('.close-btn')!;
    fireEvent.click(closeBtn);
    
    expect(setOpen).toHaveBeenCalledWith(false);
  });
});
