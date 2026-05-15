import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerPromptHandlers from '../sockets/promptHandlers.js';
import { providerRuntimeManager } from '../services/providerRuntimeManager.js';
import EventEmitter from 'events';

// Use vi.hoisted to define variables used in vi.mock
const { mockAcpClient } = vi.hoisted(() => ({
  mockAcpClient: {
    transport: {
      sendRequest: vi.fn(),
      sendNotification: vi.fn(),
      pendingRequests: new Map()
    },
    stream: {
      beginDraining: vi.fn(),
      waitForDrainToFinish: vi.fn(),
      statsCaptures: new Map(),
      onChunk: vi.fn()
    },
    permissions: {
      respond: vi.fn(),
      pendingPermissions: new Map()
    },
    providerModule: {
      onPromptStarted: vi.fn(),
      onPromptCompleted: vi.fn()
    },
    setMode: vi.fn(),
    sessionMetadata: new Map()
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
  getProviderModule: vi.fn().mockResolvedValue({})
}));

vi.mock('sharp', () => ({
  default: vi.fn()
}));

vi.mock('../mcp/subAgentRegistry.js', () => ({
  getAllRunning: vi.fn().mockReturnValue([]),
  removeSubAgentsForParent: vi.fn()
}));

vi.mock('../mcp/subAgentInvocationManager.js', () => ({
  subAgentInvocationManager: {
    cancelAllForParent: vi.fn()
  }
}));

vi.mock('../mcp/acpCleanup.js', () => ({ cleanupAcpSession: vi.fn() }));

vi.mock('../services/providerRuntimeManager.js', () => ({
  providerRuntimeManager: {
    getRuntime: vi.fn((id) => ({
      client: mockAcpClient,
      providerId: id || 'provider-a',
      provider: { config: { branding: {}, models: { default: 'test-balanced' } } }
    }))
  }
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
    mockAcpClient.stream.statsCaptures.clear();
  });

  it('should handle incoming prompt and send to ACP', async () => {
    const sessionId = 'sess-1';
    const uiId = 'ui-1';
    const prompt = 'Hello world';
    
    mockAcpClient.sessionMetadata.set(sessionId, { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true, usage: { totalTokens: 100 } });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId, sessionId, prompt, model: 'test-balanced' });

    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      sessionId,
      prompt: expect.arrayContaining([{ type: 'text', text: prompt }])
    }));
    expect(mockAcpClient.sessionMetadata.get(sessionId).usedTokens).toBe(100);
    expect(mockIo.emit).toHaveBeenCalledWith('stats_push', expect.objectContaining({ sessionId, providerId: 'provider-a', usedTokens: 100 }));
    expect(mockIo.emit).toHaveBeenCalledWith('token_done', expect.objectContaining({ sessionId, providerId: 'provider-a' }));
  });

  it('does not overwrite context-window stats with prompt response usage', async () => {
    const sessionId = 'sess-context-window';
    mockAcpClient.sessionMetadata.set(sessionId, {
      model: 'test-balanced',
      promptCount: 0,
      lastResponseBuffer: '',
      lastThoughtBuffer: '',
      usedTokens: 20000,
      totalTokens: 200000
    });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true, usage: { totalTokens: 120000 } });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-ctx', sessionId, prompt: 'continue', model: 'test-balanced' });

    expect(mockAcpClient.sessionMetadata.get(sessionId).usedTokens).toBe(20000);
    expect(mockIo.emit.mock.calls.filter(([event]) => event === 'stats_push')).toEqual([]);
    expect(mockIo.emit).toHaveBeenCalledWith('token_done', expect.objectContaining({ sessionId, providerId: 'provider-a' }));
  });

  it('should not run stop hooks directly (ACP handles them)', async () => {
    const { runHooks } = await import('../services/hookRunner.js');
    const sessionId = 'sess-stop';
    mockAcpClient.sessionMetadata.set(sessionId, { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '', agentName: 'agent-dev' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });
    runHooks.mockClear();

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-stop', sessionId, prompt: 'test', model: 'test-balanced' });

    expect(runHooks).not.toHaveBeenCalledWith(expect.anything(), 'stop', expect.anything(), expect.anything());
  });

  it('should not run stop hooks when agentName is null', async () => {
    const { runHooks } = await import('../services/hookRunner.js');
    const sessionId = 'sess-no-agent';
    mockAcpClient.sessionMetadata.set(sessionId, { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '', agentName: null });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });
    runHooks.mockClear();

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-no-agent', sessionId, prompt: 'test', model: 'test-balanced' });

    expect(runHooks).not.toHaveBeenCalledWith(expect.anything(), 'stop', expect.anything(), expect.anything());
  });

  it('should store userPrompt and title prompt history on metadata for first prompt', async () => {
    mockAcpClient.sessionMetadata.set('sess-1', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'Explain quantum computing', model: 'test-balanced' });

    const meta = mockAcpClient.sessionMetadata.get('sess-1');
    expect(meta.userPrompt).toBe('Explain quantum computing');
    expect(meta.titlePromptHistory).toEqual(['Explain quantum computing']);
    expect(meta.promptCount).toBe(1);
  });

  it('should keep userPrompt and append title prompt history on subsequent prompts', async () => {
    mockAcpClient.sessionMetadata.set('sess-1', { model: 'test-balanced', promptCount: 1, userPrompt: 'first', lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'second message', model: 'test-balanced' });

    const meta = mockAcpClient.sessionMetadata.get('sess-1');
    expect(meta.userPrompt).toBe('first');
    expect(meta.titlePromptHistory).toEqual(['first', 'second message']);
    expect(meta.promptCount).toBe(2);
  });

  it('should keep only the last two title prompts', async () => {
    mockAcpClient.sessionMetadata.set('sess-1', {
      model: 'test-balanced',
      promptCount: 2,
      userPrompt: 'first',
      titlePromptHistory: ['first', 'second'],
      lastResponseBuffer: '',
      lastThoughtBuffer: ''
    });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'third message', model: 'test-balanced' });

    const meta = mockAcpClient.sessionMetadata.get('sess-1');
    expect(meta.titlePromptHistory).toEqual(['second', 'third message']);
    expect(meta.promptCount).toBe(3);
  });

  it('should not append blank prompts to title prompt history', async () => {
    mockAcpClient.sessionMetadata.set('sess-blank', {
      model: 'test-balanced',
      promptCount: 1,
      userPrompt: 'first',
      titlePromptHistory: ['first'],
      lastResponseBuffer: '',
      lastThoughtBuffer: ''
    });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-blank', sessionId: 'sess-blank', prompt: '   ', model: 'test-balanced' });

    const meta = mockAcpClient.sessionMetadata.get('sess-blank');
    expect(meta.titlePromptHistory).toEqual(['first']);
    expect(meta.promptCount).toBe(2);
  });

  it('should not mutate title prompt history for array prompt parts', async () => {
    mockAcpClient.sessionMetadata.set('sess-array-title', {
      model: 'test-balanced',
      promptCount: 1,
      userPrompt: 'first',
      titlePromptHistory: ['first'],
      lastResponseBuffer: '',
      lastThoughtBuffer: ''
    });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({
      uiId: 'ui-array-title',
      sessionId: 'sess-array-title',
      prompt: [{ type: 'text', text: 'array prompt text' }],
      model: 'test-balanced'
    });

    const meta = mockAcpClient.sessionMetadata.get('sess-array-title');
    expect(meta.titlePromptHistory).toEqual(['first']);
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

    mockAcpClient.sessionMetadata.set('sess-1', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'look at this', model: 'test-balanced', attachments });

    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([
        expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
        expect.objectContaining({ type: 'resource_link', name: 'doc.txt' }),
        expect.objectContaining({ type: 'text', text: 'look at this' })
      ])
    }));
  });

  it('should handle prompt errors and emit error token', async () => {
    mockAcpClient.sessionMetadata.set('sess-1', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockRejectedValue(new Error('ACP Timeout'));
    
    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'fail me', model: 'test-balanced' });

    expect(mockIo.emit).toHaveBeenCalledWith('token', expect.objectContaining({
      text: expect.stringContaining('ACP Timeout')
    }));
    expect(mockIo.emit).toHaveBeenCalledWith('token_done', expect.objectContaining({ sessionId: 'sess-1', error: true, providerId: 'provider-a' }));
  });

  it('should cancel prompt when cancel_prompt received', () => {
    const handler = mockSocket.listeners('cancel_prompt')[0];
    handler({ sessionId: 'sess-1' });

    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'sess-1' });
  });

  it('should cancel running sub-agents and emit completion on cancel_prompt', async () => {
    const { subAgentInvocationManager } = await import('../mcp/subAgentInvocationManager.js');
    const handler = mockSocket.listeners('cancel_prompt')[0];
    handler({ sessionId: 'sess-1', providerId: 'provider-a' });

    expect(subAgentInvocationManager.cancelAllForParent).toHaveBeenCalledWith('sess-1', 'provider-a');
  });

  it('should forward permission response to acpClient', () => {
    const handler = mockSocket.listeners('respond_permission')[0];
    handler({ id: 'req-1', optionId: 'allow', toolCallId: 't1', sessionId: 'sess-1' });

    expect(mockAcpClient.permissions.respond).toHaveBeenCalledWith('req-1', 'allow', mockAcpClient.transport);
  });

  it('should spread array prompt parts directly into acpPromptParts', async () => {
    const parts = [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }];
    mockAcpClient.sessionMetadata.set('sess-arr', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-arr', sessionId: 'sess-arr', prompt: parts, model: 'test-balanced' });

    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }])
    }));
  });

  it('should prepend spawnContext on first prompt and clear it', async () => {
    mockAcpClient.sessionMetadata.set('sess-spawn', {
      model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '',
      spawnContext: 'You are a sub-agent. Do X.'
    });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-spawn', sessionId: 'sess-spawn', prompt: 'hello', model: 'test-balanced' });

    const sentPrompt = mockAcpClient.transport.sendRequest.mock.calls[0][1].prompt;
    expect(sentPrompt[0]).toEqual({ type: 'text', text: 'You are a sub-agent. Do X.' });

    const meta = mockAcpClient.sessionMetadata.get('sess-spawn');
    expect(meta.spawnContext).toBeNull();
  });

  it('should delete from statsCaptures and not emit error token when error occurs during stats capture', async () => {
    mockAcpClient.sessionMetadata.set('sess-stats', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockRejectedValue(new Error('timeout'));
    mockAcpClient.stream.statsCaptures.set('sess-stats', {});

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-stats', sessionId: 'sess-stats', prompt: 'hi', model: 'test-balanced' });

    expect(mockAcpClient.stream.statsCaptures.has('sess-stats')).toBe(false);
    expect(mockIo.emit).not.toHaveBeenCalledWith('token', expect.anything());
  });

  it('should reject prompts to sessions not loaded in current process', async () => {
    // No metadata set — simulates stale session after backend restart
    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'stale-sess', prompt: 'hello', model: 'test-balanced' });

    expect(mockIo.emit).toHaveBeenCalledWith('token', expect.objectContaining({
      text: expect.stringContaining('Session expired')
    }));
    expect(mockIo.emit).toHaveBeenCalledWith('token_done', expect.objectContaining({ sessionId: 'stale-sess', error: true, providerId: 'provider-a' }));
    expect(mockAcpClient.transport.sendRequest).not.toHaveBeenCalled();
  });

  it('should handle base64 image attachments without disk path', async () => {
    const attachments = [
      { name: 'screenshot.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }
    ];

    mockAcpClient.sessionMetadata.set('sess-1', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'what is this', model: 'test-balanced', attachments });

    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
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

    mockAcpClient.sessionMetadata.set('sess-1', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-1', sessionId: 'sess-1', prompt: 'parse this', model: 'test-balanced', attachments });

    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
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

    mockAcpClient.sessionMetadata.set('sess-img', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-img', sessionId: 'sess-img', prompt: 'check this', model: 'test-balanced', attachments });

    expect(sharp).toHaveBeenCalled();
    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
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

    mockAcpClient.sessionMetadata.set('sess-fallback', { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

    const handler = mockSocket.listeners('prompt')[0];
    await handler({ uiId: 'ui-fb', sessionId: 'sess-fallback', prompt: 'check this', model: 'test-balanced', attachments });

    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: expect.arrayContaining([
        expect.objectContaining({ type: 'image', mimeType: 'image/png', data: originalData })
      ])
    }));
  });

  describe('provider prompt lifecycle hooks', () => {
    it('calls onPromptStarted before sendRequest and onPromptCompleted after success', async () => {
      const sessionId = 'sess-hooks';
      mockAcpClient.sessionMetadata.set(sessionId, { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
      mockAcpClient.transport.sendRequest.mockResolvedValue({ success: true });

      const handler = mockSocket.listeners('prompt')[0];
      await handler({ uiId: 'ui-hooks', sessionId, prompt: 'hello', model: 'test-balanced' });

      expect(mockAcpClient.providerModule.onPromptStarted).toHaveBeenCalledWith(sessionId);
      expect(mockAcpClient.providerModule.onPromptCompleted).toHaveBeenCalledWith(sessionId);
      // Started must be called before the sendRequest, completed after
      const startOrder = mockAcpClient.providerModule.onPromptStarted.mock.invocationCallOrder[0];
      const sendOrder = mockAcpClient.transport.sendRequest.mock.invocationCallOrder[0];
      const endOrder = mockAcpClient.providerModule.onPromptCompleted.mock.invocationCallOrder[0];
      expect(startOrder).toBeLessThan(sendOrder);
      expect(sendOrder).toBeLessThan(endOrder);
    });

    it('calls onPromptCompleted even when sendRequest rejects (error path)', async () => {
      const sessionId = 'sess-hooks-err';
      mockAcpClient.sessionMetadata.set(sessionId, { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
      mockAcpClient.transport.sendRequest.mockRejectedValue(new Error('Network error'));

      const handler = mockSocket.listeners('prompt')[0];
      await handler({ uiId: 'ui-hooks-err', sessionId, prompt: 'fail', model: 'test-balanced' });

      expect(mockAcpClient.providerModule.onPromptStarted).toHaveBeenCalledWith(sessionId);
      expect(mockAcpClient.providerModule.onPromptCompleted).toHaveBeenCalledWith(sessionId);
    });

    it('does not call onPromptStarted when session metadata is missing', async () => {
      // No metadata set — stale session; handler returns early before the prompt
      const handler = mockSocket.listeners('prompt')[0];
      await handler({ uiId: 'ui-stale', sessionId: 'stale-hooks', prompt: 'hello', model: 'test-balanced' });

      expect(mockAcpClient.providerModule.onPromptStarted).not.toHaveBeenCalled();
      expect(mockAcpClient.providerModule.onPromptCompleted).not.toHaveBeenCalled();
    });

    it('outer catch emits error token/token_done and does not call onPromptCompleted when onPromptStarted throws', async () => {
      // onPromptStarted throws — this is a pre-prompt failure inside the outer try block.
      // The inner try/finally is never entered, so onPromptCompleted must NOT be called.
      const sessionId = 'sess-outer-catch';
      mockAcpClient.sessionMetadata.set(sessionId, { model: 'test-balanced', promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });
      mockAcpClient.providerModule.onPromptStarted.mockImplementationOnce(() => {
        throw new Error('setup failed unexpectedly');
      });

      const handler = mockSocket.listeners('prompt')[0];
      await handler({ uiId: 'ui-outer', sessionId, prompt: 'hello', model: 'test-balanced' });

      expect(mockIo.emit).toHaveBeenCalledWith('token', expect.objectContaining({
        text: expect.stringContaining('setup failed unexpectedly')
      }));
      expect(mockIo.emit).toHaveBeenCalledWith('token_done', expect.objectContaining({
        sessionId,
        error: true,
        providerId: 'provider-a'
      }));
      // The finally block inside the inner try was never reached
      expect(mockAcpClient.providerModule.onPromptCompleted).not.toHaveBeenCalled();
    });
  });
});
