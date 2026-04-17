import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const SESSIONS_DIR = '/tmp/test-sessions';

import { parseSessionHistory } from '../../providers/gemini/index.js';

// Hoist mocks to avoid initialization errors
const { mockProviderModule } = vi.hoisted(() => ({
  mockProviderModule: {
    intercept: (p) => p,
    normalizeUpdate: (u) => u,
    extractToolOutput: vi.fn((result) => {
      if (result.Success?.items) {
        const parts = result.Success.items.map(i => {
          if (i.Text) return i.Text;
          if (i.Json?.content) return i.Json.content.map(c => c.text).join('');
          if (i.Json) return JSON.stringify(i.Json);
          return '';
        }).filter(Boolean);
        return parts.join('\n') || undefined;
      }
      if (result.Error) return `Error: ${result.Error.message}`;
      return undefined;
    }),
    extractFilePath: () => undefined,
    extractDiffFromToolCall: () => undefined,
    normalizeTool: (e) => e,
    categorizeToolCall: () => null,
    parseExtension: () => null,
    performHandshake: async () => {},
    setInitialAgent: async () => {},
    getSessionPaths: (acpId) => ({ 
      jsonl: path.join('/tmp/test-sessions', `${acpId}.jsonl`), 
      json: path.join('/tmp/test-sessions', `${acpId}.json`), 
      tasksDir: path.join('/tmp/test-sessions', acpId) 
    }),
    parseSessionHistory: null,
    cloneSession: () => {},
    archiveSessionFiles: () => {},
    restoreSessionFiles: () => {},
    deleteSessionFiles: () => {},
    getSessionDir: () => SESSIONS_DIR,
    getAttachmentsDir: () => '/tmp/test-attachments',
    getAgentsDir: () => '/tmp/test-agents',
  }
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));
vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: { paths: { sessions: SESSIONS_DIR } }
  }),
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule),
  getProviderModuleSync: () => mockProviderModule
}));

let mockFiles = {};
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn((p) => p in mockFiles),
    readFileSync: vi.fn((p) => mockFiles[p] || ''),
  },
  existsSync: vi.fn((p) => p in mockFiles),
  readFileSync: vi.fn((p) => mockFiles[p] || ''),
}));

import { parseJsonlSession } from '../services/jsonlParser.js';

mockProviderModule.parseSessionHistory = parseSessionHistory;

function setJsonl(id, entries) {
  const content = entries.map(e => JSON.stringify(e)).join('\n');
  const filePath = path.join(SESSIONS_DIR, `${id}.jsonl`);
  mockFiles[filePath] = content;
}

const prompt = (text, id = 'p1') => ({ version: 'v1', kind: 'Prompt', data: { message_id: id, content: [{ kind: 'text', data: text }] } });
const assistant = (text, id = 'a1') => ({ version: 'v1', kind: 'AssistantMessage', data: { message_id: id, content: [{ kind: 'text', data: text }] } });
const assistantWithTool = (toolName, toolId, input = {}, text = '') => ({
  version: 'v1', kind: 'AssistantMessage', data: {
    message_id: 'a-tool', content: [
      ...(text ? [{ kind: 'text', data: text }] : []),
      { kind: 'toolUse', data: { toolUseId: toolId, name: toolName, input } }
    ]
  }
});
const toolResult = (toolId, result) => ({
  version: 'v1', kind: 'ToolResults', data: { message_id: 'tr1', content: [], results: { [toolId]: result } }
});

describe('jsonlParser', () => {
  beforeEach(() => {
    mockFiles = {};
    vi.clearAllMocks();
  });

  it('returns null for non-existent file', async () => {
    const result = await parseJsonlSession('none');
    expect(result).toBeNull();
  });

  it('parses simple prompt/response pair', async () => {
    setJsonl('test1', [prompt('Hello'), assistant('Hi there')]);
    const msgs = await parseJsonlSession('test1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'Hi there' });
  });

  it('merges consecutive assistant messages into single turn', async () => {
    setJsonl('test2', [
      prompt('Hello'),
      assistant('Let me check'),
      assistant('Done')
    ]);
    const msgs = await parseJsonlSession('test2');
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('Let me check');
    expect(msgs[1].content).toContain('Done');
  });

  it('builds tool title with first meaningful argument', async () => {
    setJsonl('test3', [
      assistantWithTool('read', 't1', { path: '/tmp/test.txt' })
    ]);
    const msgs = await parseJsonlSession('test3');
    expect(msgs[0].timeline[0].event.title).toBe('Running read: /tmp/test.txt');
  });

  it('extracts shell stdout/stderr', async () => {
    setJsonl('test4', [
      assistantWithTool('bash', 't1'),
      toolResult('t1', { Success: { items: [{ Text: 'hi\n' }] } })
    ]);
    const msgs = await parseJsonlSession('test4');
    expect(msgs[0].timeline[0].event.output).toBe('hi\n');
  });

  it('extracts MCP tool output from Json.content', async () => {
    setJsonl('test5', [
      assistantWithTool('mcp_tool', 't1'),
      toolResult('t1', { Success: { items: [{ Json: { content: [{ text: 'a.js\nb.js' }] } }] } })
    ]);
    const msgs = await parseJsonlSession('test5');
    expect(msgs[0].timeline[0].event.output).toBe('a.js\nb.js');
  });

  it('extracts Text items from write/read results', async () => {
    setJsonl('test6', [
      assistantWithTool('write', 't1'),
      toolResult('t1', { Success: { items: [{ Text: 'file contents here' }] } })
    ]);
    const msgs = await parseJsonlSession('test6');
    expect(msgs[0].timeline[0].event.output).toBe('file contents here');
  });

  it('uses write tool content as diff fallback when result is empty', async () => {
    setJsonl('test7', [
      assistantWithTool('write', 't1', { path: '/f.txt', content: 'new file content' }),
      toolResult('t1', { Success: { items: [] } })
    ]);
    const msgs = await parseJsonlSession('test7');
    expect(msgs[0].timeline[0].event.output).toContain('+new file content');
    expect(msgs[0].timeline[0].event.output).toContain('--- /f.txt');
  });

  it('uses write tool newStr as diff fallback for strReplace', async () => {
    setJsonl('test8', [
      assistantWithTool('strReplace', 't1', { path: '/f.txt', oldStr: 'old text', newStr: 'replaced text' }),
      toolResult('t1', { Success: { items: [] } })
    ]);
    const msgs = await parseJsonlSession('test8');
    expect(msgs[0].timeline[0].event.output).toContain('-old text');
    expect(msgs[0].timeline[0].event.output).toContain('+replaced text');
  });

  it('handles Error results', async () => {
    setJsonl('test9', [
      assistantWithTool('bash', 't1'),
      toolResult('t1', { Error: { message: 'Tool use was denied by the user.' } })
    ]);
    const msgs = await parseJsonlSession('test9');
    expect(msgs[0].timeline[0].event.output).toBe('Error: Tool use was denied by the user.');
  });

  it('handles multiple prompts producing correct user/assistant pairs', async () => {
    setJsonl('test10', [
      prompt('p1'), assistant('a1'),
      prompt('p2'), assistant('a2'),
      prompt('p3'), assistant('a3')
    ]);
    const msgs = await parseJsonlSession('test10');
    expect(msgs).toHaveLength(6);
    expect(msgs.filter(m => m.role === 'user')).toHaveLength(3);
    expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(3);
  });

  it('returns null on malformed JSON', async () => {
    mockFiles[path.join(SESSIONS_DIR, 'bad.jsonl')] = 'invalid{json}';
    const msgs = await parseJsonlSession('bad');
    expect(msgs).toBeNull();
  });
});
