import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as gemini from '../../../providers/gemini/index.js';
import fs from 'fs';
import path from 'path';

// Mock getProvider
vi.mock('../../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      protocolPrefix: '_google/',
      paths: {
        sessions: '/mock/gemini-tmp',
        attachments: '/mock/attachments',
        agents: '/mock/agents',
        archive: '/mock/archive'
      },
      toolCategories: {
        "read_file": { "category": "file_read", "isFileOperation": true },
        "write_file": { "category": "file_write", "isFileOperation": true },
        "replace": { "category": "file_edit", "isFileOperation": true },
        "edit": { "category": "file_edit", "isFileOperation": true },
        "list_directory": { "category": "glob", "isFileOperation": true },
        "glob": { "category": "glob", "isFileOperation": true }
      }
    }
  })
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    cpSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  cpSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(),
}));

describe('Gemini Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSessionPaths', () => {
    it('finds session files in project subdirectories', () => {
      fs.existsSync.mockImplementation((p) => p === '/mock/gemini-tmp' || p.includes('chats'));
      fs.readdirSync.mockImplementation((p) => {
        if (p === '/mock/gemini-tmp') return [{ name: 'project-1', isDirectory: () => true }];
        if (p.includes('chats')) return ['session-2026-04-22-shortid.jsonl', 'session-2026-04-22-shortid.json'];
        return [];
      });

      const paths = gemini.getSessionPaths('shortid');
      expect(paths.jsonl).toContain('session-2026-04-22-shortid.jsonl');
      expect(paths.json).toContain('session-2026-04-22-shortid.json');
    });

    it('falls back to standard location if not found in project subdirectories', () => {
      fs.existsSync.mockImplementation((p) => p === '/mock/gemini-tmp'); // Only tmpBase exists
      const paths = gemini.getSessionPaths('shortid');
      expect(paths.jsonl).toBe(path.join('/mock/gemini-tmp', 'shortid.jsonl'));
    });
  });

  describe('performHandshake', () => {
    it('sends authenticate request', async () => {
      const mockClient = { sendRequest: vi.fn().mockResolvedValue({}) };
      await gemini.performHandshake(mockClient);
      expect(mockClient.sendRequest).toHaveBeenCalledWith('authenticate', expect.any(Object));
    });
  });

  describe('Session Operations', () => {
    const acpId = 'sess-123';

    it('deleteSessionFiles unlinks files', () => {
      fs.existsSync.mockReturnValue(true);
      gemini.deleteSessionFiles(acpId);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
      expect(fs.rmSync).toHaveBeenCalled();
    });

    it('archiveSessionFiles copies and unlinks', () => {
      fs.existsSync.mockReturnValue(true);
      gemini.archiveSessionFiles(acpId, '/archive/dir');
      expect(fs.copyFileSync).toHaveBeenCalledTimes(2);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    });

    it('restoreSessionFiles copies back files matching .jsonl/.json', () => {
      fs.readdirSync.mockReturnValue(['sess-123.jsonl', 'sess-123.json', 'other.txt']);
      fs.existsSync.mockReturnValue(true);
      gemini.restoreSessionFiles(acpId, '/archive/dir');
      expect(fs.copyFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('normalizeTool', () => {
    it('normalizes gemini tool names', () => {
      const event = { id: 'call_read_123', title: 'call_read_123' };
      const normalized = gemini.normalizeTool(event);
      expect(normalized.toolName).toBe('read_file');
    });
  });

  describe('categorizeToolCall', () => {
    it('categorizes file tools', () => {
      const cat = gemini.categorizeToolCall({ toolName: 'read_file' });
      expect(cat.toolCategory).toBe('file_read');
      expect(cat.isFileOperation).toBe(true);
    });
  });

  describe('getHooksForAgent', () => {
    it('reads SessionStart hooks from settings.json', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo start' }] }
          ]
        }
      }));
      const hooks = await gemini.getHooksForAgent(null, 'session_start');
      expect(hooks).toEqual([{ command: 'echo start' }]);
    });

    it('preserves matcher from outer entry', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({
        hooks: {
          Stop: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo stop' }] }
          ]
        }
      }));
      const hooks = await gemini.getHooksForAgent(null, 'stop');
      expect(hooks).toEqual([{ command: 'echo stop', matcher: 'Bash' }]);
    });

    it('returns [] when settings.json has no hooks', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({}));
      const hooks = await gemini.getHooksForAgent(null, 'session_start');
      expect(hooks).toEqual([]);
    });

    it('returns [] when settings.json is missing', async () => {
      fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const hooks = await gemini.getHooksForAgent(null, 'stop');
      expect(hooks).toEqual([]);
    });

    it('returns [] for unknown hookType', async () => {
      const hooks = await gemini.getHooksForAgent(null, 'unknown');
      expect(hooks).toEqual([]);
    });
  });
});
