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
vi.mock('../sockets/helpDocsHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/gitHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/terminalHandlers.js', () => ({ default: vi.fn() }));
vi.mock('../sockets/shellRunHandlers.js', () => ({
  default: vi.fn(),
  emitShellRunSnapshotsForSession: vi.fn()
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));
vi.mock('../services/acpClient.js', () => ({
  default: { providerId: 'test', isHandshakeComplete: true, serverBootId: 'test-boot' }
}));
vi.mock('../services/providerRegistry.js', () => ({
  getDefaultProviderId: vi.fn(() => 'test'),
  getProviderEntries: vi.fn(() => [{ id: 'test', label: 'Test', path: './providers/test' }])
}));
vi.mock('../services/providerRuntimeManager.js', () => ({
  default: {
    getRuntimes: vi.fn(() => [{ providerId: 'test', client: { isHandshakeComplete: true, serverBootId: 'test-boot' } }])
  }
}));
vi.mock('../services/workspaceConfig.js', () => ({ loadWorkspaces: vi.fn().mockReturnValue([]) }));
vi.mock('../services/commandsConfig.js', () => ({ loadCommands: vi.fn().mockReturnValue([]) }));
vi.mock('../services/jsonConfigDiagnostics.js', () => ({
  collectInvalidJsonConfigErrors: vi.fn(() => []),
  hasStartupBlockingJsonConfigError: vi.fn((errors) => errors.some(error => error.blocksStartup === true))
}));
vi.mock('../database.js', () => ({
  initDb: vi.fn(() => Promise.resolve()),
  getProviderStatusExtensions: vi.fn(() => Promise.resolve([])),
  getSessionByAcpId: vi.fn(() => Promise.resolve(null)),
  getSubAgentInvocationsForParent: vi.fn(() => Promise.resolve([])),
  getSubAgentInvocationWithAgents: vi.fn(() => Promise.resolve(null))
}));
vi.mock('../services/providerStatusMemory.js', () => ({
  getLatestProviderStatusExtension: vi.fn(() => null),
  getLatestProviderStatusExtensions: vi.fn(() => [])
}));
vi.mock('../services/sessionStreamPersistence.js', () => ({
  getStreamResumeSnapshot: vi.fn().mockResolvedValue(null)
}));
vi.mock('../services/providerLoader.js', () => ({ 
  getProvider: () => ({
    id: 'test',
    config: { 
      providerId: 'test',
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
import { collectInvalidJsonConfigErrors } from '../services/jsonConfigDiagnostics.js';
import { getDefaultProviderId } from '../services/providerRegistry.js';
import { getLatestProviderStatusExtension, getLatestProviderStatusExtensions } from '../services/providerStatusMemory.js';
import providerRuntimeManager from '../services/providerRuntimeManager.js';
import { getProviderStatusExtensions } from '../database.js';
import { getStreamResumeSnapshot } from '../services/sessionStreamPersistence.js';

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

function flushPromises() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('Socket Index Handler', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    collectInvalidJsonConfigErrors.mockReturnValue([]);
    getLatestProviderStatusExtension.mockReturnValue(null);
    getLatestProviderStatusExtensions.mockReturnValue([]);
    getProviderStatusExtensions.mockResolvedValue([]);
    getStreamResumeSnapshot.mockResolvedValue(null);
    providerRuntimeManager.getRuntimes.mockReturnValue([{ providerId: 'test', client: { isHandshakeComplete: true, serverBootId: 'test-boot' } }]);
    mockIo = new EventEmitter();
    mockIo.engine = { clientsCount: 1 };
    registerSocketHandlers(mockIo);
  });

  it('registers all modular handlers on connection', async () => {
    connectSocket(mockIo);
    const promptHandlers = (await import('../sockets/promptHandlers.js')).default;
    const sessionHandlers = (await import('../sockets/sessionHandlers.js')).default;
    const helpDocsHandlers = (await import('../sockets/helpDocsHandlers.js')).default;
    const shellRunHandlers = (await import('../sockets/shellRunHandlers.js')).default;
    expect(promptHandlers).toHaveBeenCalled();
    expect(sessionHandlers).toHaveBeenCalled();
    expect(helpDocsHandlers).toHaveBeenCalled();
    expect(shellRunHandlers).toHaveBeenCalled();
  });

  it('emits config_errors on connection', () => {
    const s = connectSocket(mockIo);
    expect(s.emit).toHaveBeenCalledWith('config_errors', { errors: [] });
  });

  it('blocks normal hydration when startup JSON config is invalid', async () => {
    const issue = {
      id: 'provider-registry',
      label: 'Provider registry',
      path: 'configuration/providers.json',
      message: 'Unexpected token',
      blocksStartup: true
    };
    collectInvalidJsonConfigErrors.mockReturnValue([issue]);

    const s = connectSocket(mockIo);
    const promptHandlers = (await import('../sockets/promptHandlers.js')).default;

    expect(s.emit).toHaveBeenCalledWith('config_errors', { errors: [issue] });
    expect(s.emit).not.toHaveBeenCalledWith('providers', expect.anything());
    expect(promptHandlers).not.toHaveBeenCalled();
  });

  it('preserves existing diagnostics when runtime config loading fails', () => {
    const existingIssue = {
      id: 'commands-config',
      label: 'Custom commands configuration',
      path: 'commands.json',
      message: 'Unexpected token'
    };
    collectInvalidJsonConfigErrors.mockReturnValue([existingIssue]);
    getDefaultProviderId.mockImplementationOnce(() => {
      throw new Error('Provider registry is missing defaultProviderId');
    });

    const s = connectSocket(mockIo);

    expect(s.emit).toHaveBeenCalledWith('config_errors', { errors: [existingIssue] });
    expect(s.emit).toHaveBeenCalledWith('config_errors', {
      errors: [
        existingIssue,
        expect.objectContaining({
          id: 'runtime-config-load',
          message: 'Provider registry is missing defaultProviderId',
          blocksStartup: true
        })
      ]
    });
    expect(s.emit).not.toHaveBeenCalledWith('providers', expect.anything());
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
    expect(s.emit).toHaveBeenCalledWith('providers', expect.objectContaining({
      defaultProviderId: 'test',
      providers: expect.arrayContaining([
        expect.objectContaining({ providerId: 'test' })
      ])
    }));
    expect(s.emit).toHaveBeenCalledWith('branding', expect.objectContaining({ providerId: 'test', assistantName: 'Test' }));
  });

  it('emits cached provider status on connection', () => {
    const providerStatusExtension = {
      method: '_test.dev/provider/status',
      params: {
        status: {
          providerId: 'test',
          sections: [{ id: 'usage', items: [{ id: 'five-hour', label: '5h', value: '42%' }] }]
        }
      }
    };
    getLatestProviderStatusExtension.mockReturnValue(providerStatusExtension);
    getLatestProviderStatusExtensions.mockReturnValue([providerStatusExtension]);

    const s = connectSocket(mockIo);

    expect(s.emit).toHaveBeenCalledWith('provider_extension', providerStatusExtension);
  });

  it('emits persisted provider status on connection when memory is empty', async () => {
    const persistedExtension = {
      method: '_test.dev/provider/status',
      params: { status: { providerId: 'test', sections: [] } }
    };
    getProviderStatusExtensions.mockResolvedValue([persistedExtension]);

    const s = connectSocket(mockIo);
    await flushPromises();

    expect(s.emit).toHaveBeenCalledWith('provider_extension', persistedExtension);
  });

  it('does not emit persisted provider status over newer memory status for the same provider', async () => {
    const memoryExtension = {
      method: '_test.dev/provider/status',
      params: { status: { providerId: 'test', sections: [{ id: 'memory', items: [] }] } }
    };
    const persistedExtension = {
      method: '_test.dev/provider/status',
      params: { status: { providerId: 'test', sections: [{ id: 'persisted', items: [] }] } }
    };
    getLatestProviderStatusExtensions.mockReturnValue([memoryExtension]);
    getProviderStatusExtensions.mockResolvedValue([persistedExtension]);

    const s = connectSocket(mockIo);
    await flushPromises();

    expect(s.emit).toHaveBeenCalledWith('provider_extension', memoryExtension);
    expect(s.emit).not.toHaveBeenCalledWith('provider_extension', persistedExtension);
  });
});

describe('Socket Index - session rooms', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    collectInvalidJsonConfigErrors.mockReturnValue([]);
    getLatestProviderStatusExtension.mockReturnValue(null);
    getLatestProviderStatusExtensions.mockReturnValue([]);
    getProviderStatusExtensions.mockResolvedValue([]);
    getStreamResumeSnapshot.mockResolvedValue(null);
    providerRuntimeManager.getRuntimes.mockReturnValue([{ providerId: 'test', client: { isHandshakeComplete: true, serverBootId: 'test-boot' } }]);
    mockIo = new EventEmitter();
    mockIo.engine = { clientsCount: 1 };
    registerSocketHandlers(mockIo);
  });

  it('watch_session joins the session room', () => {
    const s = connectSocket(mockIo);
    s.emit('watch_session', { sessionId: 'sess-123' });
    expect(s.join).toHaveBeenCalledWith('session:sess-123');
  });

  it('watch_session emits shell run snapshots', async () => {
    const { emitShellRunSnapshotsForSession } = await import('../sockets/shellRunHandlers.js');
    const s = connectSocket(mockIo);
    s.emit('watch_session', { providerId: 'provider-a', sessionId: 'sess-123' });
    expect(emitShellRunSnapshotsForSession).toHaveBeenCalledWith(s, { providerId: 'provider-a', sessionId: 'sess-123' });
  });

  it('watch_session emits a stream resume snapshot when active progress exists', async () => {
    const snapshot = { providerId: 'provider-a', sessionId: 'sess-123', message: { id: 'a1', role: 'assistant', content: 'partial', isStreaming: true } };
    providerRuntimeManager.getRuntimes.mockReturnValue([{ providerId: 'provider-a', client: { isHandshakeComplete: true, serverBootId: 'test-boot' } }]);
    getStreamResumeSnapshot.mockResolvedValue(snapshot);
    const s = connectSocket(mockIo);

    s.emit('watch_session', { providerId: 'provider-a', sessionId: 'sess-123' });
    await flushPromises();

    expect(getStreamResumeSnapshot).toHaveBeenCalledWith(expect.any(Object), 'sess-123');
    expect(s.emit).toHaveBeenCalledWith('stream_resume_snapshot', snapshot);
  });

  it('watch_session emits pending permission snapshots', () => {
    const permissionPayload = { id: 'perm-1', providerId: 'provider-a', sessionId: 'sess-123', options: [] };
    providerRuntimeManager.getRuntimes.mockReturnValue([{ providerId: 'provider-a', client: {
      isHandshakeComplete: true,
      serverBootId: 'test-boot',
      permissions: { getPendingPermissionForSession: vi.fn().mockReturnValue(permissionPayload) }
    } }]);

    const s = connectSocket(mockIo);
    s.emit('watch_session', { providerId: 'provider-a', sessionId: 'sess-123' });

    expect(s.emit).toHaveBeenCalledWith('permission_request', permissionPayload);
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
