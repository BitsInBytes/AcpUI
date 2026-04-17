import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn(() => ({
    config: { models: { titleGeneration: 'mock-title-model', balanced: { id: 'balanced-id' } } }
  }))
}));

vi.mock('../mcp/acpCleanup.js', () => ({
  cleanupAcpSession: vi.fn()
}));

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    getSessionByAcpId: vi.fn(),
    updateSessionName: vi.fn(),
  },
}));
vi.mock('../database.js', () => mockDb);

import { generateTitle, generateForkTitle } from '../services/acpTitleGenerator.js';

describe('acpTitleGenerator', () => {
  let acpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockEmit = vi.fn();
    acpClient = {
      sendRequest: vi.fn().mockResolvedValue({ sessionId: 'title-sess' }),
      statsCaptures: new Map(),
      sessionMetadata: new Map(),
      io: { emit: mockEmit, to: () => ({ emit: mockEmit }) },
    };
  });

  it('should not generate if no userPrompt on meta', async () => {
    await generateTitle(acpClient, 'sess-1', {});
    expect(acpClient.sendRequest).not.toHaveBeenCalled();
  });

  it('should create session, send prompt, capture response, update DB', async () => {
    acpClient.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        acpClient.statsCaptures.set('title-sess', { buffer: 'My Title' });
      }
      return {};
    });
    mockDb.getSessionByAcpId.mockResolvedValue({ id: 'ui-1', name: 'New Chat' });

    await generateTitle(acpClient, 'sess-1', { userPrompt: 'Hello world' });

    expect(acpClient.sendRequest).toHaveBeenCalledWith('session/new', expect.any(Object));
    expect(acpClient.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({ sessionId: 'title-sess' }));
    expect(mockDb.updateSessionName).toHaveBeenCalledWith('ui-1', 'My Title');
    expect(acpClient.io.emit).toHaveBeenCalledWith('session_renamed', { uiId: 'ui-1', newName: 'My Title' });
  });

  it('should not rename if name is not New Chat and ALWAYS_RENAME_CHATS is false', async () => {
    delete process.env.ALWAYS_RENAME_CHATS;
    acpClient.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        acpClient.statsCaptures.set('title-sess', { buffer: 'A Title' });
      }
      return {};
    });
    mockDb.getSessionByAcpId.mockResolvedValue({ id: 'ui-1', name: 'Existing Name' });

    await generateTitle(acpClient, 'sess-1', { userPrompt: 'Hello' });

    expect(mockDb.updateSessionName).not.toHaveBeenCalled();
  });
});



describe('generateForkTitle', () => {
  let acpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockEmit = vi.fn();
    acpClient = {
      sendRequest: vi.fn().mockResolvedValue({ sessionId: 'title-sess' }),
      statsCaptures: new Map(),
      sessionMetadata: new Map(),
      io: { emit: mockEmit, to: () => ({ emit: mockEmit }) },
    };
  });

  it('generates title from last 2 user and assistant messages', async () => {
    acpClient.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        acpClient.statsCaptures.set('title-sess', { buffer: 'Fork Title' });
      }
      return {};
    });

    const messages = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Second answer' },
    ];

    await generateForkTitle(acpClient, 'fork-ui-1', messages, 3);

    expect(mockDb.updateSessionName).toHaveBeenCalledWith('fork-ui-1', 'Fork Title');
    expect(acpClient.io.emit).toHaveBeenCalledWith('session_renamed', { uiId: 'fork-ui-1', newName: 'Fork Title' });
  });

  it('does nothing when messages are empty', async () => {
    await generateForkTitle(acpClient, 'fork-ui-1', [], 0);
    expect(acpClient.sendRequest).not.toHaveBeenCalled();
  });

  it('only uses messages up to forkPoint', async () => {
    acpClient.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        // Verify the prompt only contains messages up to index 1
        const promptCall = acpClient.sendRequest.mock.calls.find(c => c[0] === 'session/prompt');
        const text = promptCall[1].prompt[0].text;
        expect(text).toContain('First question');
        expect(text).not.toContain('Third question');
        acpClient.statsCaptures.set('title-sess', { buffer: 'Early Fork' });
      }
      return {};
    });

    const messages = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Third question' },
      { role: 'assistant', content: 'Third answer' },
    ];

    await generateForkTitle(acpClient, 'fork-ui-1', messages, 1);
    expect(mockDb.updateSessionName).toHaveBeenCalledWith('fork-ui-1', 'Early Fork');
  });
});
