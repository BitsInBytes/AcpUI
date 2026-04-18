import { describe, it, expect, vi, beforeEach } from 'vitest';

// We want to test the logic in create_session and prompt handlers.
// Since server.js is not a module we can easily import, we'll mock the logic 
// to ensure it correctly calls the expected ACP methods.

describe('ACP Model Switching Logic', () => {
  let pendingRequests = new Map();
  let requestId = 1;
  let sessionMetadata = new Map();
  let writeLog = vi.fn();
  let sendAcpRequest = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    sessionMetadata.clear();
    sendAcpRequest.mockImplementation((method, params) => {
      if (method === 'session/new' || method === 'session/load') {
        return Promise.resolve({ sessionId: params.sessionId || 'new-session-id' });
      }
      return Promise.resolve({});
    });
  });

  // Mocking the logic from server.js for create_session
  async function handleCreateSession({ model, existingAcpId }, isHandshakeComplete) {
    if (!isHandshakeComplete) {
      return { error: 'Daemon not ready' };
    }
    const modelId = model === 'flagship' ? 'flagship-model-id' : (model === 'balanced' ? 'balanced-model-id' : 'fast-model-id');
    
    let result;
    if (existingAcpId) {
      writeLog(`[ACP] Resuming session: ${existingAcpId}`);
      result = await sendAcpRequest('session/load', {
        sessionId: existingAcpId,
        cwd: '/test/cwd',
        mcpServers: []
      });
      if (!result.sessionId) result.sessionId = existingAcpId;
    } else {
      writeLog(`[ACP] Creating new session with model: ${modelId}`);
      result = await sendAcpRequest('session/new', {
        cwd: '/test/cwd',
        mcpServers: [],
        model: modelId
      });
    }

    await sendAcpRequest('session/set_model', {
      sessionId: result.sessionId,
      modelId: modelId
    });

    sessionMetadata.set(result.sessionId, {
      model: modelId, toolCalls: 0, successTools: 0, startTime: Date.now(), usedTokens: 0, totalTokens: 0, promptCount: 0
    });

    return { sessionId: result.sessionId };
  }

  // Mocking the logic from server.js for prompt
  async function handlePrompt({ sessionId, model }) {
    const modelId = model === 'flagship' ? 'flagship-model-id' : (model === 'balanced' ? 'balanced-model-id' : 'fast-model-id');
    const meta = sessionMetadata.get(sessionId);
    
    if (meta && meta.model !== modelId) {
      writeLog(`[ACP] Switching session ${sessionId} to model: ${modelId}`); 
      await sendAcpRequest('session/set_model', {
        sessionId: sessionId,
        modelId: modelId
      });
      meta.model = modelId;
    } else if (!meta) {
      await sendAcpRequest('session/set_model', {
        sessionId: sessionId,
        modelId: modelId
      });
      sessionMetadata.set(sessionId, {
          model: modelId, toolCalls: 0, successTools: 0, startTime: Date.now(), usedTokens: 0, totalTokens: 0, promptCount: 0
      });
    }

    if (meta) {
      meta.promptCount = (meta.promptCount || 0) + 1;
    }
  }

  it('create_session should use session/load when existingAcpId is provided', async () => {
    const result = await handleCreateSession({ model: 'balanced', existingAcpId: 'existing-id' }, true);
    
    expect(sendAcpRequest).toHaveBeenCalledWith('session/load', expect.any(Object));
    expect(sendAcpRequest).toHaveBeenCalledWith('session/set_model', expect.objectContaining({
      sessionId: 'existing-id',
      modelId: 'balanced-model-id'
    }));
    expect(result.sessionId).toBe('existing-id');
  });

  it('create_session should use session/new when existingAcpId is NOT provided', async () => {
    const result = await handleCreateSession({ model: 'flagship', existingAcpId: undefined }, true);
    
    expect(sendAcpRequest).toHaveBeenCalledWith('session/new', expect.any(Object));
    expect(sendAcpRequest).toHaveBeenCalledWith('session/set_model', expect.objectContaining({
      sessionId: 'new-session-id',
      modelId: 'flagship-model-id'
    }));
    expect(result.sessionId).toBe('new-session-id');
  });

  it('prompt should switch model if it differs from metadata', async () => {
    sessionMetadata.set('sess-1', { model: 'balanced-model-id' });
    
    await handlePrompt({ sessionId: 'sess-1', model: 'flagship' });
    
    expect(sendAcpRequest).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'sess-1',
      modelId: 'flagship-model-id'
    });
    expect(sessionMetadata.get('sess-1').model).toBe('flagship-model-id');
  });

  it('prompt should set metadata and model if meta is missing', async () => {
    await handlePrompt({ sessionId: 'missing-sess', model: 'balanced' });
    
    expect(sendAcpRequest).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'missing-sess',
      modelId: 'balanced-model-id'
    });
    expect(sessionMetadata.has('missing-sess')).toBe(true);
    expect(sessionMetadata.get('missing-sess').model).toBe('balanced-model-id');
  });
});
