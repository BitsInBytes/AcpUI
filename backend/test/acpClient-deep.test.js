import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import acpClient from '../services/acpClient.js';
import { spawn } from 'child_process';
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

vi.mock('../database.js', () => ({
  initDb: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

const { mockProviderModule } = vi.hoisted(() => ({
  mockProviderModule: {
    intercept: (p) => p,
    normalizeUpdate: (u) => u,
    extractToolOutput: (u) => undefined,
    extractFilePath: (u, resolve) => {
      const title = (u.title || '').toLowerCase();
      if (title.startsWith('listing') || title.startsWith('running:')) return undefined;
      if (u.locations?.[0]?.path) return resolve(u.locations[0].path);
      if (u.content?.[0]?.path) return resolve(u.content[0].path);
      const args = u.arguments || u.params || u.rawInput;
      if (args) {
        const p = args.path || args.file_path || args.filePath;
        if (p) return resolve(p);
      }
      return undefined;
    },
    extractDiffFromToolCall: () => undefined,
    normalizeTool: (e) => e,
    categorizeToolCall: () => null,
    parseExtension: () => null,
    performHandshake: async () => {},
    setInitialAgent: async () => {},
    getSessionPaths: () => ({ jsonl: '', json: '', tasksDir: '' }),
    cloneSession: () => {},
    archiveSessionFiles: () => {},
    restoreSessionFiles: () => {},
    deleteSessionFiles: () => {},
    getAgentsDir: () => '/tmp/test-agents'
  }
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      name: 'Test',
      command: 'test-cli',
      args: ['acp'],
      protocolPrefix: '_test.dev/',
      paths: { sessions: '/tmp/test-sessions', agents: '/tmp/test-agents', attachments: '/tmp/test-attachments' },
      }
  }),
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule),
  getProviderModuleSync: vi.fn().mockReturnValue(mockProviderModule)
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    realpathSync: vi.fn(p => p)
  }
}));

describe('AcpClient Service - Deep Coverage', () => {
  let mockProcess;
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockProcess = new EventEmitter();
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.stdin = { write: vi.fn() };
    spawn.mockReturnValue(mockProcess);
    
    const mockEmit = vi.fn();
    mockIo = { emit: mockEmit, to: () => ({ emit: mockEmit }) };
    acpClient.io = mockIo;
    acpClient.acpProcess = mockProcess;
    acpClient.requestId = 1;
    acpClient.pendingRequests.clear();
    acpClient.drainingSessions.clear();
    acpClient.sessionMetadata.clear();
    acpClient.providerModule = mockProviderModule;
  });

  describe('Agent Tool Handling', () => {
    const sessionId = 'tool-sess';
    beforeEach(() => {
        acpClient.sessionMetadata.set(sessionId, { toolCalls: 0, successTools: 0, usedTokens: 0 });
    });

    it('should extract path from various tool update locations', async () => {
        await acpClient.handleUpdate(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', locations: [{ path: '/mnt/c/repos/file1.txt' }] });
        expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
            type: 'tool_start',
            filePath: expect.stringContaining('file1.txt')
        }));
    });
  });
});
