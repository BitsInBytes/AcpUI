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
  getSessionByAcpId: vi.fn().mockResolvedValue({ id: 'ui-1', name: 'New Chat', messages: [] }),
  updateSessionName: vi.fn().mockResolvedValue({}),
  saveSession: vi.fn().mockResolvedValue({})
}));

describe('acpTitleGenerator', () => {
  let acpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ALWAYS_RENAME_CHATS;
    db.getSessionByAcpId.mockResolvedValue({ id: 'ui-1', name: 'New Chat', messages: [] });
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

    await generateTitle(acpClient, 'acp-1', { userPrompt: 'hello', provider: 'p1', promptCount: 1 });

    expect(acpClient.transport.sendRequest).toHaveBeenCalledWith('session/new', expect.any(Object));
    expect(acpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.any(Object));
    expect(db.updateSessionName).toHaveBeenCalledWith('ui-1', 'Mock Title');
    expect(acpClient.io.emit).toHaveBeenCalledWith('session_renamed', expect.objectContaining({ newName: 'Mock Title' }));
  });

  it('should include current title and last two prompts for progressive rename', async () => {
    process.env.ALWAYS_RENAME_CHATS = 'true';
    let titlePrompt;
    db.getSessionByAcpId.mockResolvedValueOnce({
      id: 'ui-1',
      name: 'Feature X',
      messages: [{ role: 'user', content: 'Older setup prompt' }]
    });
    acpClient.transport.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        titlePrompt = params.prompt[0].text;
        acpClient.stream.statsCaptures.set('title-sess', { buffer: 'Feature Y' });
      }
      return {};
    });

    await generateTitle(acpClient, 'acp-1', {
      titlePromptHistory: ['Keep working on Feature X', 'Switch focus to Feature Y'],
      promptCount: 2
    });

    expect(titlePrompt).toContain('Current title: "Feature X"');
    expect(titlePrompt).toContain('Prompt 1: Keep working on Feature X');
    expect(titlePrompt).toContain('Prompt 2: Switch focus to Feature Y');
    expect(titlePrompt).not.toContain('Older setup prompt');
    expect(titlePrompt).toContain('return the current title exactly');
    expect(db.updateSessionName).toHaveBeenCalledWith('ui-1', 'Feature Y');
  });

  it('should not emit rename when generated title matches the current title', async () => {
    process.env.ALWAYS_RENAME_CHATS = 'true';
    db.getSessionByAcpId.mockResolvedValueOnce({ id: 'ui-1', name: 'Feature X', messages: [] });
    acpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        acpClient.stream.statsCaptures.set('title-sess', { buffer: 'Feature X' });
      }
      return {};
    });

    await generateTitle(acpClient, 'acp-1', { titlePromptHistory: ['Refine Feature X'], promptCount: 2 });

    expect(db.updateSessionName).not.toHaveBeenCalled();
    expect(acpClient.io.emit).not.toHaveBeenCalledWith('session_renamed', expect.any(Object));
  });

  it('should limit title prompt context to 400 characters per prompt', async () => {
    const longPrompt = 'a'.repeat(450);
    let titlePrompt;
    acpClient.transport.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        titlePrompt = params.prompt[0].text;
        acpClient.stream.statsCaptures.set('title-sess', { buffer: 'Long Prompt Title' });
      }
      return {};
    });

    await generateTitle(acpClient, 'acp-1', { titlePromptHistory: [longPrompt], promptCount: 1 });

    expect(titlePrompt).toContain(`Prompt 1: ${'a'.repeat(400)}...`);
    expect(titlePrompt).not.toContain('a'.repeat(401));
  });

  it('should skip stale progressive titles when another prompt starts first', async () => {
    process.env.ALWAYS_RENAME_CHATS = 'true';
    const meta = { titlePromptHistory: ['Rename this work'], promptCount: 2 };
    acpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'title-sess' };
      if (method === 'session/prompt') {
        meta.promptCount = 3;
        acpClient.stream.statsCaptures.set('title-sess', { buffer: 'Stale Title' });
      }
      return {};
    });

    await generateTitle(acpClient, 'acp-1', meta);

    expect(db.updateSessionName).not.toHaveBeenCalled();
    expect(acpClient.io.emit).not.toHaveBeenCalledWith('session_renamed', expect.any(Object));
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

    db.getSessionByAcpId.mockResolvedValueOnce({ id: 'ui-1', name: 'Existing Name', messages: [] });
    await generateTitle(acpClient, 'acp-1', { userPrompt: 'hello', provider: 'p1', name: 'Existing Name', promptCount: 1 });
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
