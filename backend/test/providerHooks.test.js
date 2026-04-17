import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock high-level dependencies
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('Provider Interop Hooks', () => {
  let acpClient;
  let providerLoader;
  let acpUpdateHandler;
  let acpCleanup;

  beforeEach(async () => {
    vi.resetModules();
    // Import modules after reset
    providerLoader = await import('../services/providerLoader.js');
    acpClient = (await import('../services/acpClient.js')).default;
    acpUpdateHandler = await import('../services/acpUpdateHandler.js');
    acpCleanup = await import('../mcp/acpCleanup.js');
    
    // Default mock for getProvider
    vi.spyOn(providerLoader, 'getProvider').mockReturnValue({
      config: { 
        name: 'TestProvider',
        paths: { sessions: '/tmp/sessions' }
      }
    });
  });

  describe('acpClient.init() Handshake Hook', () => {
    it('should call performHandshake', async () => {
      const mockHandshake = vi.fn().mockResolvedValue();
      vi.spyOn(providerLoader, 'getProviderModule').mockResolvedValue({
        performHandshake: mockHandshake
      });

      // Mock the base spawn and JSON-RPC infrastructure
      acpClient.acpProcess = { stdin: { write: vi.fn() }, on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } };
      acpClient.sendRequest = vi.fn().mockResolvedValue({ result: 'initialized' });
      acpClient.io = { emit: vi.fn() };

      await acpClient.performHandshake();

      expect(mockHandshake).toHaveBeenCalledWith(acpClient);
    });
  });

  describe('acpUpdateHandler.handleUpdate() Normalization Hook', () => {
    it('should use provider.normalizeUpdate', async () => {
      const mockNormalize = vi.fn().mockImplementation(u => ({ ...u, sessionUpdate: 'agent_message_chunk', content: { text: 'Normalized' } }));
      vi.spyOn(providerLoader, 'getProviderModule').mockResolvedValue({
        normalizeUpdate: mockNormalize,
        extractFilePath: vi.fn()
      });

      const mockEmit = vi.fn();
      const mockClient = { 
        sessionMetadata: new Map([['s1', { usedTokens: 0 }]]),
        drainingSessions: new Map(),
        statsCaptures: new Map(),
        io: { to: vi.fn().mockReturnValue({ emit: mockEmit }) }
      };

      const rawUpdate = { type: 'LegacyUpdate', data: 'raw' };
      await acpUpdateHandler.handleUpdate(mockClient, 's1', rawUpdate);

      expect(mockNormalize).toHaveBeenCalledWith(rawUpdate);
      expect(mockEmit).toHaveBeenCalledWith('token', expect.objectContaining({ text: 'Normalized' }));
    });

    it('should use provider.extractFilePath', async () => {
        const mockExtract = vi.fn().mockReturnValue('/resolved/path.txt');
        vi.spyOn(providerLoader, 'getProviderModule').mockResolvedValue({
          normalizeUpdate: (u) => u,
          extractFilePath: mockExtract,
          extractDiffFromToolCall: vi.fn(),
          normalizeTool: (e) => e,
          categorizeToolCall: vi.fn(),
        });

        const mockEmit = vi.fn();
        const mockClient = { 
            sessionMetadata: new Map([['s1', { toolCalls: 0 }]]),
            drainingSessions: new Map(),
            statsCaptures: new Map(),
            io: { to: vi.fn().mockReturnValue({ emit: mockEmit }) }
        };

        const update = { sessionUpdate: 'tool_call', toolCallId: 't1' };
        await acpUpdateHandler.handleUpdate(mockClient, 's1', update);

        expect(mockExtract).toHaveBeenCalled();
        expect(mockEmit).toHaveBeenCalledWith('system_event', expect.objectContaining({
            type: 'tool_start',
            filePath: '/resolved/path.txt'
        }));
    });
  });

  describe('acpCleanup.cleanupAcpSession() Discovery Hook', () => {
    it('should use provider.deleteSessionFiles', async () => {
      const mockDelete = vi.fn();
      vi.spyOn(providerLoader, 'getProviderModule').mockResolvedValue({
        deleteSessionFiles: mockDelete
      });

      await acpCleanup.cleanupAcpSession('sess-123');

      expect(mockDelete).toHaveBeenCalledWith('sess-123');
    });
  });
});
