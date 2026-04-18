import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Hoist mocks to avoid initialization errors
const { mockProviderModule, mockFs } = vi.hoisted(() => ({
  mockProviderModule: {
    parseSessionHistory: vi.fn(),
    getSessionPaths: vi.fn((id) => ({ jsonl: `/tmp/${id}.jsonl` }))
  },
  mockFs: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn(),
  }
}));

vi.mock('../services/providerLoader.js', () => ({
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule)
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

vi.mock('fs', () => ({
  default: mockFs,
  existsSync: (...args) => mockFs.existsSync(...args),
  readFileSync: (...args) => mockFs.readFileSync(...args),
}));

import { parseJsonlSession } from '../services/jsonlParser.js';

describe('jsonlParser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
  });

  it('parses simple prompt/response pair', async () => {
    mockFs.readFileSync.mockReturnValue('{"type":"prompt","content":"Hello"}\n{"type":"assistant_message","content":"Hi there"}');
    mockProviderModule.parseSessionHistory.mockReturnValue([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ]);

    const msgs = await parseJsonlSession('test1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'Hi there' });
  });

  it('delegates parsing to providerModule', async () => {
    mockFs.readFileSync.mockReturnValue('{"type":"assistant_message","content":"Let me check"}\n{"type":"assistant_message","content":"Done"}');
    const mockMsgs = [
      { role: 'assistant', content: 'Let me check' },
      { role: 'assistant', content: 'Done' }
    ];
    mockProviderModule.parseSessionHistory.mockReturnValue(mockMsgs);

    const msgs = await parseJsonlSession('test2');
    expect(msgs).toHaveLength(2);
    expect(msgs).toEqual(mockMsgs);
  });

  it('returns null on malformed JSON', async () => {
    mockFs.readFileSync.mockReturnValue('invalid json');
    mockProviderModule.parseSessionHistory.mockImplementation(() => { throw new Error('fail'); });

    const msgs = await parseJsonlSession('bad');
    expect(msgs).toBeNull();
  });

  it('returns null and logs when provider lacks parseSessionHistory', async () => {
    const { getProviderModule } = await import('../services/providerLoader.js');
    getProviderModule.mockResolvedValueOnce({ getSessionPaths: mockProviderModule.getSessionPaths }); // no parseSessionHistory

    const msgs = await parseJsonlSession('noparse');
    expect(msgs).toBeNull();
  });
});
