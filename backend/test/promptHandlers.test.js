import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerPromptHandlers from '../sockets/promptHandlers.js';
import EventEmitter from 'events';

// Use vi.hoisted to define variables used in vi.mock
const { mockAcpClient } = vi.hoisted(() => ({
  mockAcpClient: {
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
    setMode: vi.fn(),
    respondToPermission: vi.fn(),
    sessionMetadata: new Map(),
    statsCaptures: new Map()
  }
}));

vi.mock('../services/acpClient.js', () => ({
  default: mockAcpClient,
  toUnixPath: (p) => p
}));

vi.mock('../database.js', () => ({
  getSession: vi.fn(),
  updateSessionName: vi.fn()
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

vi.mock('../services/sessionManager.js', () => ({
  autoSaveTurn: vi.fn()
}));
vi.mock('../services/hookRunner.js', () => ({
  runHooks: vi.fn().mockResolvedValue([])
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fake data'))
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
      clientInfo: { name: 'TestUI', version: '1.0.0' },
      branding: { assistantName: 'Test' },
      models: { flagship: { id: 'test-flagship', displayName: 'Flagship' }, balanced: { id: 'test-balanced', displayName: 'Balanced' }, titleGeneration: 'test-balanced' },
    }
  }),
  getProviderModule: vi.fn().mockResolvedValue({})
}));

vi.mock('sharp', () => ({
  default: vi.fn()
}));

vi.mock('../mcp/subAgentRegistry.js', () => ({
  getAllRunning: vi.fn().mockReturnValue([]),
  removeSubAgentsForParent: vi.fn()
}));

vi.mock('../mcp/acpCleanup.js', () => ({
  cleanupAcpSession: vi.fn()
}));

describe('Prompt Handlers', () => {
  let mockIo;
  let mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockEmit = vi.fn();
    mockIo = { emit: mockEmit, to: () => ({ emit: mockEmit }) };
    mockSocket = new EventEmitter();
    registerPromptHandlers(mockIo, mockSocket);
    mockAcpClient.sessionMetadata.clear();
    mockAcpClient.statsCaptures.clear();
  });

  it('should handle incoming prompt and send to ACP', async () => {
    const sessionId = 'sess-1';
    const uiId = 'ui-1';
    const prompt = 'Hello world';
    
    mockAcpClient.sessionMetadata.set(sessionId, { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true, usage: { totalTokens: 100 } });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId, sessionId, prompt, model: 'balanced' });

    expect(mockAcpClient.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      sessionId,
      prompt: expect.arrayContaining([{ type: 'text', text: prompt }])
    }));
    expect(mockIo.emit).toHaveBeenCalledWith('token_done', { sessionId });
  });

  it('should not run stop hooks directly (ACP handles them)', async () => {
    const { runHooks } = await import('../services/hookRunner.js');
    const sessionId = 'sess-stop';
    mockAcpClient.sessionMetadata.set(sessionId, { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '', agentName: 'agent-dev' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });
    runHooks.mockClear();

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-stop', sessionId, prompt: 'test', model: 'balanced' });

    expect(runHooks).not.toHaveBeenCalledWith(expect.anything(), 'stop', expect.anything(), expect.anything());
  });

  it('should not run stop hooks when agentName is null', async () => {
    const { runHooks } = await import('../services/hookRunner.js');
    const sessionId = 'sess-no-agent';
    mockAcpClient.sessionMetadata.set(sessionId, { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '', agentName: null });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });
    runHooks.mockClear();

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-no-agent', sessionId, prompt: 'test', model: 'balanced' });

    expect(runHooks).not.toHaveBeenCalledWith(expect.anything(), 'stop', expect.anything(), expect.anything());
  });

  it('should store userPrompt on metadata for first prompt', async () => {
    mockAcpClient.sessionMetadata.set('sess-1', { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'Explain quantum computing', model: 'balanced' });

    const meta = mockAcpClient.sessionMetadata.get('sess-1');
    expect(meta.userPrompt).toBe('Explain quantum computing');
    expect(meta.promptCount).toBe(1);
  });

  it('should not store userPrompt on subsequent prompts', async () => {
    mockAcpClient.sessionMetadata.set('sess-1', { model: 'balanced-model-id', promptCount: 1, userPrompt: 'first', lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'second message', model: 'balanced' });

    const meta = mockAcpClient.sessionMetadata.get('sess-1');
    expect(meta.userPrompt).toBe('first');
    expect(meta.promptCount).toBe(2);
  });

  it('should handle set_mode errors gracefully', async () => {
    mockAcpClient.setMode.mockRejectedValue(new Error('Mode switch failed'));
    
    const handler = mockSocket.listeners('set_mode')[0];
    await handler({ sessionId: 'sess-1', modeId: 'agent_planner' });

    const { writeLog } = await import('../services/logger.js');
    expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('Error setting mode'));
  });

  it('should handle attachments (images and resource links)', async () => {
    const attachments = [
      { name: 'img.png', path: '/path/img.png', mimeType: 'image/png' },
      { name: 'doc.txt', path: '/path/doc.txt', mimeType: 'text/plain' }
    ];

    mockAcpClient.sessionMetadata.set('sess-1', { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'look at this', model: 'balanced', attachments });

    expect(mockAcpClient.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([
        expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
        expect.objectContaining({ type: 'resource_link', name: 'doc.txt' }),
        expect.objectContaining({ type: 'text', text: 'look at this' })
      ])
    }));
  });

  it('should handle prompt errors and emit error token', async () => {
    mockAcpClient.sessionMetadata.set('sess-1', { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockRejectedValue(new Error('ACP Timeout'));
    
    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'fail me', model: 'balanced' });

    expect(mockIo.emit).toHaveBeenCalledWith('token', expect.objectContaining({
      text: expect.stringContaining('ACP Timeout')
    }));
    expect(mockIo.emit).toHaveBeenCalledWith('token_done', { sessionId: 'sess-1', error: true });
  });

  it('should cancel prompt when cancel_prompt received', () => {
    const handler = mockSocket.listeners('cancel_prompt')[0];
    handler({ sessionId: 'sess-1' });

    expect(mockAcpClient.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'sess-1' });
  });

  it('should call and clear _abortSubAgents on cancel', () => {
    const abortFn = vi.fn();
    mockAcpClient._abortSubAgents = abortFn;

    const handler = mockSocket.listeners('cancel_prompt')[0];
    handler({ sessionId: 'sess-1' });

    expect(abortFn).toHaveBeenCalled();
    expect(mockAcpClient._abortSubAgents).toBeNull();
  });

  it('should cancel running sub-agents and emit completion on cancel_prompt', async () => {
    const { getAllRunning, removeSubAgentsForParent } = await import('../mcp/subAgentRegistry.js');
    const rejectFn = vi.fn();
    const sub = { acpId: 'sub-acp-1', index: 0 };
    getAllRunning.mockReturnValue([sub]);
    mockAcpClient.pendingRequests = new Map([
      ['req-1', { params: { sessionId: 'sub-acp-1' }, reject: rejectFn }]
    ]);

    const handler = mockSocket.listeners('cancel_prompt')[0];
    handler({ sessionId: 'sess-1' });

    expect(mockAcpClient.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'sub-acp-1' });
    expect(rejectFn).toHaveBeenCalledWith(expect.any(Error));
    expect(mockIo.emit).toHaveBeenCalledWith('sub_agent_completed', expect.objectContaining({ acpSessionId: 'sub-acp-1', error: 'Cancelled' }));
    expect(removeSubAgentsForParent).toHaveBeenCalledWith(null);
  });

  it('should forward permission response to acpClient', () => {
    const handler = mockSocket.listeners('respond_permission')[0];
    handler({ id: 'req-1', optionId: 'allow', toolCallId: 't1', sessionId: 'sess-1' });

    expect(mockAcpClient.respondToPermission).toHaveBeenCalledWith('req-1', 'allow');
  });

  it('should spread array prompt parts directly into acpPromptParts', async () => {
    const parts = [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }];
    mockAcpClient.sessionMetadata.set('sess-arr', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-arr', sessionId: 'sess-arr', prompt: parts, model: 'balanced' });

    expect(mockAcpClient.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }])
    }));
  });

  it('should prepend spawnContext on first prompt and clear it', async () => {
    mockAcpClient.sessionMetadata.set('sess-spawn', {
      model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '',
      spawnContext: 'You are a sub-agent. Do X.'
    });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-spawn', sessionId: 'sess-spawn', prompt: 'hello', model: 'balanced' });

    const sentPrompt = mockAcpClient.sendRequest.mock.calls[0][1].prompt;
    expect(sentPrompt[0]).toEqual({ type: 'text', text: 'You are a sub-agent. Do X.' });

    const meta = mockAcpClient.sessionMetadata.get('sess-spawn');
    expect(meta.spawnContext).toBeNull();
  });

  it('should delete from statsCaptures and not emit error token when error occurs during stats capture', async () => {
    mockAcpClient.sessionMetadata.set('sess-stats', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockRejectedValue(new Error('timeout'));
    mockAcpClient.statsCaptures.set('sess-stats', {});

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-stats', sessionId: 'sess-stats', prompt: 'hi', model: 'balanced' });

    expect(mockAcpClient.statsCaptures.has('sess-stats')).toBe(false);
    expect(mockIo.emit).not.toHaveBeenCalledWith('token', expect.anything());
  });

  it('should reject prompts to sessions not loaded in current process', async () => {
    // No metadata set — simulates stale session after backend restart
    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'stale-sess', prompt: 'hello', model: 'balanced' });

    expect(mockIo.emit).toHaveBeenCalledWith('token', expect.objectContaining({
      text: expect.stringContaining('Session expired')
    }));
    expect(mockIo.emit).toHaveBeenCalledWith('token_done', { sessionId: 'stale-sess', error: true });
    expect(mockAcpClient.sendRequest).not.toHaveBeenCalled();
  });

  it('should handle base64 image attachments without disk path', async () => {
    const attachments = [
      { name: 'screenshot.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }
    ];

    mockAcpClient.sessionMetadata.set('sess-1', { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'what is this', model: 'balanced', attachments });

    expect(mockAcpClient.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([
        expect.objectContaining({ type: 'image', data: 'iVBORw0KGgo=' })
      ])
    }));
  });

  it('should decode non-image base64 files as text content', async () => {
    const jsonContent = Buffer.from('{"key": "value"}').toString('base64');
    const attachments = [
      { name: 'data.json', mimeType: 'application/json', data: jsonContent }
    ];

    mockAcpClient.sessionMetadata.set('sess-1', { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'parse this', model: 'balanced', attachments });

    expect(mockAcpClient.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('{"key": "value"}') })
      ])
    }));
  });

  it('should set mode when set_mode received', async () => {
    const handler = mockSocket.listeners('set_mode')[0];
    await handler({ sessionId: 'sess-1', modeId: 'agent_planner' });

    expect(mockAcpClient.setMode).toHaveBeenCalledWith('sess-1', 'agent_planner');
  });

  it('should compress image attachments via sharp before sending to ACP', async () => {
    const sharp = (await import('sharp')).default;
    const fakeCompressed = Buffer.from('compressed');
    sharp.mockReturnValue({
      resize: vi.fn().mockReturnThis(),
      jpeg: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockResolvedValue(fakeCompressed),
    });

    const originalData = Buffer.from('original image data').toString('base64');
    const attachments = [{ name: 'photo.png', mimeType: 'image/png', data: originalData }];

    mockAcpClient.sessionMetadata.set('sess-img', { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-img', sessionId: 'sess-img', prompt: 'check this', model: 'balanced', attachments });

    expect(sharp).toHaveBeenCalled();
    expect(mockAcpClient.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([
        expect.objectContaining({ type: 'image', mimeType: 'image/jpeg', data: fakeCompressed.toString('base64') })
      ])
    }));
  });

  it('should send original image as fallback if sharp fails', async () => {
    const sharp = (await import('sharp')).default;
    sharp.mockReturnValue({
      resize: vi.fn().mockReturnThis(),
      jpeg: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockRejectedValue(new Error('sharp broke')),
    });

    const originalData = Buffer.from('original image data').toString('base64');
    const attachments = [{ name: 'photo.png', mimeType: 'image/png', data: originalData }];

    mockAcpClient.sessionMetadata.set('sess-fallback', { model: 'balanced-model-id', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-fb', sessionId: 'sess-fallback', prompt: 'check this', model: 'balanced', attachments });

    expect(mockAcpClient.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([
        expect.objectContaining({ type: 'image', mimeType: 'image/png', data: originalData })
      ])
    }));
  });
});
