import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import SessionSettingsModal from '../components/SessionSettingsModal';
import { useUIStore } from '../store/useUIStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';

describe('SessionSettingsModal', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    
    act(() => {
      useSystemStore.setState({ socket: mockSocket, branding: { modelLabel: 'Model' } } as any);
      useUIStore.setState({ isSettingsOpen: true, settingsSessionId: 's1', settingsInitialTab: 'session' });
      useSessionLifecycleStore.setState({ 
        sessions: [{ 
            id: 's1', 
            name: 'Test', 
            acpSessionId: 'a1', 
            model: 'm1',
            configOptions: [{ id: 'opt1', name: 'Opt 1', type: 'select', options: [{ value: 'v1', name: 'V1' }] }] 
        } as any] 
      });
    });
  });

  it('renders session info by default', () => {
    render(<SessionSettingsModal />);
    expect(screen.getByText('ACP Session ID')).toBeInTheDocument();
    expect(screen.getByText('a1')).toBeInTheDocument();
  });

  it('switches tabs and renders model selection', () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Config'));
    expect(screen.getByText('Model Selection')).toBeInTheDocument();
  });

  it('handles rehydrate request', async () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Rehydrate'));
    
    const btn = screen.getByText('Rebuild from JSONL');
    mockSocket.emit.mockImplementation((event: string, _params: any, cb: any) => {
      if (event === 'rehydrate_session') cb({ success: true, messageCount: 5 });
    });

    fireEvent.click(btn);
    expect(await screen.findByText(/Rebuilt 5 messages/)).toBeInTheDocument();
  });

  it('handles delete session flow with confirmation', () => {
    const deleteSpy = vi.fn();
    act(() => {
       useSessionLifecycleStore.setState({ handleDeleteSession: deleteSpy });
    });

    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Delete'));
    
    const deleteBtn = screen.getByText('Delete Chat');
    fireEvent.click(deleteBtn);
    
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Yes, Delete'));
    
    expect(deleteSpy).toHaveBeenCalled();
  });
  
  it('handles export request', () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Export'));
    
    const input = screen.getByPlaceholderText(/exports/);
    fireEvent.change(input, { target: { value: 'C:\\exports' } });
    
    // Target the button specifically to avoid tab ambiguity
    const exportBtn = screen.getAllByRole('button', { name: /^Export$/ }).find(el => el.className.includes('done-button'))!;
    fireEvent.click(exportBtn);
    expect(mockSocket.emit).toHaveBeenCalledWith('export_session', expect.objectContaining({ exportPath: 'C:\\exports' }), expect.any(Function));
  });
});
