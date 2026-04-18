import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateTitle, generateForkTitle } from '../services/acpTitleGenerator.js';
import * as db from '../database.js';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn(() => ({
    config: { models: { titleGeneration: 'mock-title-model', balanced: { id: 'balanced-id' } } }
  })),
  getProviderModule: vi.fn().mockResolvedValue({
    deleteSessionFiles: vi.fn()
  })
}));

vi.mock('../database.js', () => ({
  getSession: vi.fn(),
  getSessionByAcpId: vi.fn().mockResolvedValue({ id: 'ui-1', name: 'New Chat' }),
  updateSessionName: vi.fn().mockResolvedValue({}),
  saveSession: vi.fn().mockResolvedValue({})
}));

describe('acpTitleGenerator', () => {
  let acpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockEmit = vi.fn();
    acpClient = {
      transport: { 
        sendRequest: vi.fn().mockResolvedValue({ sessionId: 'title-sess' }),
        sendNotification: vi.fn()
      },
      stream: { 
        statsCaptures: new Map(),
        onChunk: vi.fn(),
        beginDraining: vi.fn(),
        waitForDrainToFinish: vi.fn().mockResolvedValue()
      },
      sessionMetadata: new Map(),
      io: { emit: mockEmit, to: () => ({ emit: mockEmit }) }
    };
  });

  it('should not generate if no userPrompt on meta', async () => {
    await generateTitle(acpClient, 'sess-1', {});
    expect(acpClient.transport.sendRequest).not.toHaveBeenCalled();
  });

  it('should create session, send prompt, capture response, update DB', async () => {
    acpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        acpClient.stream.statsCaptures.set('title-sess', { buffer: 'Mock Title' });
      }
      return {};
    });

    await generateTitle(acpClient, 'ui-1', { userPrompt: 'hello', provider: 'p1' });

    expect(acpClient.transport.sendRequest).toHaveBeenCalledWith('session/new', expect.any(Object));
    expect(acpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.any(Object));
    expect(db.updateSessionName).toHaveBeenCalledWith('ui-1', 'Mock Title');
    expect(acpClient.io.emit).toHaveBeenCalledWith('session_renamed', expect.objectContaining({ newName: 'Mock Title' }));
  });

  it('should not rename if name is not New Chat and ALWAYS_RENAME_CHATS is false', async () => {
    delete process.env.ALWAYS_RENAME_CHATS;
    acpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        acpClient.stream.statsCaptures.set('title-sess', { buffer: 'Should not use' });
      }
      return {};
    });

    db.getSessionByAcpId.mockResolvedValueOnce({ id: 'ui-1', name: 'Existing Name' });
    await generateTitle(acpClient, 'ui-1', { userPrompt: 'hello', provider: 'p1', name: 'Existing Name' });
    expect(db.updateSessionName).not.toHaveBeenCalled();
  });
});

describe('generateForkTitle', () => {
  let acpClient;
  const mockEmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    acpClient = {
      transport: { 
        sendRequest: vi.fn().mockResolvedValue({ sessionId: 'title-sess' }),
        sendNotification: vi.fn()
      },
      stream: { 
        statsCaptures: new Map(),
        onChunk: vi.fn(),
        beginDraining: vi.fn(),
        waitForDrainToFinish: vi.fn().mockResolvedValue()
      },
      sessionMetadata: new Map(),
      io: { emit: mockEmit, to: () => ({ emit: mockEmit }) }
    };
  });

  it('generates title from last 2 user and assistant messages', async () => {
    acpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        acpClient.stream.statsCaptures.set('title-sess', { buffer: 'Fork Title' });
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
    
    expect(acpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('First question') }),
        expect.objectContaining({ text: expect.stringContaining('Second question') })
      ])
    }));
    expect(db.updateSessionName).toHaveBeenCalledWith('fork-ui-1', 'Fork Title');
    expect(acpClient.io.emit).toHaveBeenCalledWith('session_renamed', expect.objectContaining({ uiId: 'fork-ui-1', newName: 'Fork Title' }));
  });

  it('does nothing when messages are empty', async () => {
    await generateForkTitle(acpClient, 'fork-ui-1', [], 0);
    expect(acpClient.transport.sendRequest).not.toHaveBeenCalled();
  });

  it('only uses messages up to forkPoint', async () => {
    acpClient.transport.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        const promptText = params.prompt[0].text;
        if (promptText.includes('First question') && !promptText.includes('Second question')) {
           acpClient.stream.statsCaptures.set('title-sess', { buffer: 'Early Fork' });
        }
      }
      return {};
    });

    const messages = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Third answer' },
    ];

    await generateForkTitle(acpClient, 'fork-ui-1', messages, 1);
    expect(db.updateSessionName).toHaveBeenCalledWith('fork-ui-1', 'Early Fork');
  });
});
