import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerSessionHandlers from '../sockets/sessionHandlers.js';
import registerArchiveHandlers from '../sockets/archiveHandlers.js';
import registerPromptHandlers from '../sockets/promptHandlers.js';
import registerSystemHandlers from '../sockets/systemHandlers.js';
import EventEmitter from 'events';
import fs from 'fs';

// 1. Hoist Mocks
const { mockFs, mockDb, mockAcpClient, mockProviderModule } = vi.hoisted(() => ({
    mockFs: {
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue('{}'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        cpSync: vi.fn(),
        rmSync: vi.fn(),
        copyFileSync: vi.fn(),
        readdirSync: vi.fn().mockReturnValue([]),
        statSync: vi.fn().mockReturnValue({ isDirectory: () => true })
    },
    mockDb: {
        saveSession: vi.fn().mockResolvedValue(undefined),
        getSession: vi.fn().mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', name: 'Test', messages: [], provider: 'provider-a' }),
        getSessionByAcpId: vi.fn().mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', name: 'Test', messages: [], model: 'test-balanced', configOptions: [], provider: 'provider-a' }),
        getAllSessions: vi.fn().mockResolvedValue([]),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue(undefined),
        saveConfigOptions: vi.fn().mockResolvedValue(undefined),
        saveModelState: vi.fn().mockResolvedValue(undefined),
        getNotes: vi.fn().mockResolvedValue(''),
        saveNotes: vi.fn().mockResolvedValue(undefined)
    },
    mockAcpClient: {
        isHandshakeComplete: true,
        sessionMetadata: new Map(),
        transport: {
            sendRequest: vi.fn(),
            sendNotification: vi.fn(),
            pendingRequests: new Map()
        },
        stream: {
            beginDraining: vi.fn(),
            waitForDrainToFinish: vi.fn().mockResolvedValue(),
            statsCaptures: new Map(),
            onChunk: vi.fn()
        },
        permissions: {
            respond: vi.fn(),
            pendingPermissions: new Map()
        },
        handleUpdate: vi.fn().mockResolvedValue(),
    },
    mockProviderModule: {
        intercept: (p) => p,
        normalizeUpdate: (u) => u,
        normalizeModelState: (s) => s,
        normalizeConfigOptions: (u) => u,
        prepareAcpEnvironment: async (env) => env,
        emitCachedContext: vi.fn().mockReturnValue(false),
        extractToolOutput: vi.fn(),
        extractFilePath: vi.fn(),
        extractDiffFromToolCall: vi.fn(),
        normalizeTool: (e) => e,
        categorizeToolCall: vi.fn(),
        parseExtension: vi.fn(),
        performHandshake: async () => {},
        setInitialAgent: async () => {},
        setConfigOption: vi.fn().mockResolvedValue({}),
        getSessionPaths: vi.fn((acpId) => ({ 
            jsonl: `/tmp/sessions/${acpId}.jsonl`, 
            json: `/tmp/sessions/${acpId}.json`, 
            tasksDir: `/tmp/sessions/${acpId}` 
        })),
        cloneSession: vi.fn(),
        archiveSessionFiles: vi.fn(),
        restoreSessionFiles: vi.fn(),
        deleteSessionFiles: vi.fn(),
        getAgentsDir: vi.fn().mockReturnValue('/tmp/test-agents'),
        getAttachmentsDir: vi.fn().mockReturnValue('/tmp/test-attachments'),
        getSessionDir: vi.fn().mockReturnValue('/tmp/test-sessions'),
        buildSessionParams: vi.fn().mockReturnValue(undefined)
    }
}));

// 2. Apply Mocks
vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn(),
  setIo: vi.fn(),
  getLogFilePath: vi.fn().mockReturnValue('/tmp/backend_logs.txt')
}));

vi.mock('fs', () => ({ default: mockFs }));

vi.mock('../services/acpClient.js', () => ({
  default: mockAcpClient,
  toUnixPath: (p) => p
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: (id) => ({
    id: id || 'provider-a',
    config: {
      name: 'Test',
      command: 'test-cli',
      args: ['acp'],
      protocolPrefix: '_test.dev/',
      paths: { sessions: '/tmp/test-sessions', agents: '/tmp/test-agents', attachments: '/tmp/test-attachments', archive: '/tmp/archives' },
      clientInfo: { name: 'TestUI', version: '1.0.0' },
      branding: { assistantName: 'Test' },
      models: {
        default: 'test-balanced',
        quickAccess: [
          { id: 'test-flagship', displayName: 'Flagship' },
          { id: 'test-balanced', displayName: 'Balanced' }
        ],
        titleGeneration: 'test-balanced'
      },
    }
  }),
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule),
  getProviderModuleSync: vi.fn().mockReturnValue(mockProviderModule)
}));

vi.mock('../services/providerRuntimeManager.js', () => ({
  providerRuntimeManager: {
    getRuntime: vi.fn((id) => ({
      client: mockAcpClient,
      providerId: id || 'provider-a',
      provider: { id: id || 'provider-a', config: { branding: {}, models: { default: 'test-balanced' } } }
    })),
    getClient: vi.fn().mockReturnValue(mockAcpClient)
  }
}));

vi.mock('../services/attachmentVault.js', () => ({
  getAttachmentsRoot: () => '/tmp/test-attachments',
  upload: { array: () => (req, res, next) => next() },
  handleUpload: vi.fn()
}));

vi.mock('../database.js', () => mockDb);

describe('Socket Handlers', () => {
  let mockIo, mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = new EventEmitter();
    mockIo.emit = vi.fn();
    mockIo.to = vi.fn().mockReturnThis();
    
    mockSocket = new EventEmitter();
    mockSocket.id = 'test-socket';
    mockSocket.join = vi.fn();
    mockSocket.emit = vi.fn();
    
    mockAcpClient.sessionMetadata.clear();
    mockAcpClient.sessionMetadata.set('acp-1', { model: 'test-flagship', promptCount: 0 });
    mockAcpClient.isHandshakeComplete = true;
    
    registerSessionHandlers(mockIo, mockSocket);
    registerArchiveHandlers(mockIo, mockSocket);
    registerPromptHandlers(mockIo, mockSocket);
    registerSystemHandlers(mockIo, mockSocket);
  });

  describe('Session Handlers', () => {
    it('create_session should return success', async () => {
      mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-1' });
      const callback = vi.fn();
      const handler = mockSocket.listeners('create_session')[0];
      await handler({ providerId: 'provider-a', model: 'test-flagship' }, callback);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: true, acpSessionId: 'acp-1' }));
    });

    it('create_session with existingAcpId should load without firing /context', async () => {
        mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-existing' });
        const callback = vi.fn();
        const handler = mockSocket.listeners('create_session')[0];
        await handler({ providerId: 'provider-a', existingAcpId: 'acp-existing' }, callback);
        expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/load', expect.anything());
        expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/set_model', {
          sessionId: 'acp-existing',
          modelId: 'test-balanced'
        });
        expect(mockAcpClient.transport.sendRequest).not.toHaveBeenCalledWith('session/prompt', expect.objectContaining({
          prompt: [{ type: 'text', text: '/context' }]
        }));
    });
  });

  describe('Archive Handlers', () => {
    it('list_archives should return folder names', async () => {
      mockFs.readdirSync.mockReturnValue(['Chat One', 'Chat Two']);
      const callback = vi.fn();
      const handler = mockSocket.listeners('list_archives')[0];
      handler({ providerId: 'provider-a' }, callback);
      expect(callback).toHaveBeenCalledWith({ archives: ['Chat One', 'Chat Two'] });
    });
  });

  describe('Prompt Handlers', () => {
    it('prompt should call sendRequest session/prompt', async () => {
      mockDb.getSession.mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', name: 'Untitled', provider: 'provider-a' });
      mockAcpClient.transport.sendRequest.mockResolvedValue({ usage: { totalTokens: 100 } });
      const handler = mockSocket.listeners('prompt')[0];
      await handler({ providerId: 'provider-a', uiId: 'ui-1', sessionId: 'acp-1', prompt: 'hello', model: 'test-flagship' });
      expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
        prompt: expect.arrayContaining([expect.objectContaining({ text: 'hello' })])
      }));
    });
  });

  describe('System Handlers', () => {
    it('get_logs should emit log_history', () => {
      mockFs.readFileSync.mockReturnValue('log entry 1\nlog entry 2');
      const handler = mockSocket.listeners('get_logs')[0];
      handler();
      expect(mockSocket.emit).toHaveBeenCalledWith('log_history', expect.stringContaining('log entry 1'));
    });
  });
});
