import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

// Mock all modular handlers
vi.mock('../sockets/promptHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/sessionHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/archiveHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/canvasHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/systemHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/voiceHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/systemSettingsHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/folderHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/fileExplorerHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/gitHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/terminalHandlers.js', () => ({ default: vi.fn() }));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));
vi.mock('../services/acpClient.js', () => ({
  default: { isHandshakeComplete: true, serverBootId: 'test-boot' }
}));
vi.mock('../services/workspaceConfig.js', () => ({ loadWorkspaces: vi.fn().mockReturnValue([]) }));
vi.mock('../services/commandsConfig.js', () => ({ loadCommands: vi.fn().mockReturnValue([]) }));
vi.mock('../services/providerLoader.js', () => ({ 
  getProvider: () => ({ 
    config: { 
      name: 'Test', 
      command: 'test-cli', 
      args: ['acp'], 
      protocolPrefix: '_test.dev/',
      paths: { sessions: '/tmp/test-sessions', agents: '/tmp/test-agents', attachments: '/tmp/test-attachments' },
      clientInfo: { name: 'TestUI', version: '1.0.0' },
      branding: { assistantName: 'Test' },
      models: { flagship: { id: 'test-flagship', displayName: 'Flagship' }, balanced: { id: 'test-balanced', displayName: 'Balanced' }, titleGeneration: 'test-balanced' }
    } 
  }),
  getProviderModule: vi.fn().mockResolvedValue({})
}));
vi.mock('../voiceService.js', () => ({ isSTTEnabled: vi.fn().mockReturnValue(false) }));

import registerSocketHandlers from '../sockets/index.js';

function connectSocket(mockIo) {
  const mockSocket = new EventEmitter();
  mockSocket.id = `sock-${Date.now()}`;
  mockSocket.join = vi.fn();
  mockSocket.leave = vi.fn();
  const origEmit = mockSocket.emit.bind(mockSocket);
  mockSocket.emit = vi.fn(origEmit);
  mockIo.emit('connection', mockSocket);
  return mockSocket;
}

describe('Socket Index Handler', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = new EventEmitter();
    mockIo.engine = { clientsCount: 1 };
    registerSocketHandlers(mockIo);
  });

  it('registers all modular handlers on connection', async () => {
    connectSocket(mockIo);
    const promptHandlers = (await import('../sockets/promptHandlers.js')).default;
    const sessionHandlers = (await import('../sockets/sessionHandlers.js')).default;
    expect(promptHandlers).toHaveBeenCalled();
    expect(sessionHandlers).toHaveBeenCalled();
  });

  it('emits sidebar_settings on connection', () => {
    process.env.SIDEBAR_DELETE_PERMANENT = 'true';
    const s = connectSocket(mockIo);
    expect(s.emit).toHaveBeenCalledWith('sidebar_settings', expect.objectContaining({ deletePermanent: true }));
    delete process.env.SIDEBAR_DELETE_PERMANENT;
  });

  it('emits custom_commands on connection', () => {
    const s = connectSocket(mockIo);
    expect(s.emit).toHaveBeenCalledWith('custom_commands', expect.objectContaining({ commands: expect.any(Array) }));
  });

  it('emits branding on connection', () => {
    const s = connectSocket(mockIo);
    expect(s.emit).toHaveBeenCalledWith('branding', expect.objectContaining({ assistantName: 'Test' }));
  });
});

describe('Socket Index - session rooms', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = new EventEmitter();
    mockIo.engine = { clientsCount: 1 };
    registerSocketHandlers(mockIo);
  });

  it('watch_session joins the session room', () => {
    const s = connectSocket(mockIo);
    s.emit('watch_session', { sessionId: 'sess-123' });
    expect(s.join).toHaveBeenCalledWith('session:sess-123');
  });

  it('unwatch_session leaves the session room', () => {
    const s = connectSocket(mockIo);
    s.emit('unwatch_session', { sessionId: 'sess-456' });
    expect(s.leave).toHaveBeenCalledWith('session:sess-456');
  });

  it('watch_session does nothing when sessionId is falsy', () => {
    const s = connectSocket(mockIo);
    s.emit('watch_session', { sessionId: '' });
    expect(s.join).not.toHaveBeenCalled();
  });

  it('unwatch_session does nothing when sessionId is falsy', () => {
    const s = connectSocket(mockIo);
    s.emit('unwatch_session', { sessionId: null });
    expect(s.leave).not.toHaveBeenCalled();
  });

  it('disconnect does not crash', () => {
    const s = connectSocket(mockIo);
    expect(() => s.emit('disconnect')).not.toThrow();
  });
});
