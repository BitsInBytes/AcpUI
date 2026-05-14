import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from './logger.js';
import * as db from '../database.js';
import { getProvider, getProviderModule, getProviderModuleSync } from './providerLoader.js';
import {
  extractModelState,
  mergeModelOptions,
  modelOptionsFromProviderConfig,
  resolveModelSelection
} from './modelOptions.js';
import { mergeConfigOptions, normalizeConfigOptions } from './configOptions.js';
import { bindMcpProxy, createMcpProxyBinding, getMcpProxyAuthToken, getMcpProxyIdFromServers } from '../mcp/mcpProxyRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function emitCachedContext(providerModule, sessionId) {
  if (!sessionId) return;
  try {
    providerModule.emitCachedContext(sessionId);
  } catch (err) {
    writeLog(`[SESSION] Failed to emit cached context for ${sessionId}: ${err.message}`);
  }
}

// Helper for MCP servers stdio transport
export function getMcpServers(providerId, { acpSessionId = null } = {}) {
  const name = getProvider(providerId).config.mcpName;
  if (!name) return [];
  const providerModule = getProviderModuleSync(providerId);
  const mcpServerMeta = providerModule.getMcpServerMeta?.();
  const proxyPath = path.resolve(__dirname, '..', 'mcp', 'stdio-proxy.js');
  const proxyId = createMcpProxyBinding({ providerId, acpSessionId });
  const proxyAuthToken = getMcpProxyAuthToken(proxyId);
  return [{
    name,
    command: 'node',
    args: [proxyPath],
    env: [
      { name: 'ACP_SESSION_PROVIDER_ID', value: String(providerId) },
      { name: 'ACP_UI_MCP_PROXY_ID', value: proxyId },
      { name: 'ACP_UI_MCP_PROXY_AUTH_TOKEN', value: String(proxyAuthToken || '') },
      { name: 'BACKEND_PORT', value: String(process.env.BACKEND_PORT || 3005) },
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
    ],
    ...(mcpServerMeta ? { _meta: mcpServerMeta } : {})
  }];
}

function hasConfigValue(option) {
  return option && Object.prototype.hasOwnProperty.call(option, 'currentValue') && option.currentValue !== undefined;
}

function isConfigValueAdvertised(savedOption, advertisedOption) {
  if (!savedOption || !advertisedOption || !hasConfigValue(savedOption)) return false;
  if (Object.is(savedOption.currentValue, advertisedOption.currentValue)) return false;

  if (advertisedOption.type === 'select' && Array.isArray(advertisedOption.options)) {
    return advertisedOption.options.some(option => option.value === savedOption.currentValue);
  }

  return true;
}

export async function setProviderConfigOption(acpClient, providerModule, sessionId, optionId, value) {
  return await providerModule.setConfigOption(acpClient, sessionId, optionId, value);
}

export function normalizeProviderConfigOptions(providerModule, options) {
  const providerOptions = providerModule.normalizeConfigOptions(options);
  return normalizeConfigOptions(providerOptions);
}

export function getConfigOptionsFromSetResult(result, optionId, value, providerModule = null) {
  const returnedOptions = normalizeProviderConfigOptions(providerModule, result?.configOptions);
  return returnedOptions.length > 0 ? returnedOptions : [{ id: optionId, currentValue: value }];
}

export async function reapplySavedConfigOptions(acpClient, sessionId, savedOptions, providerModule) {
  if (!Array.isArray(savedOptions) || savedOptions.length === 0) return;

  const meta = acpClient.sessionMetadata.get(sessionId);
  const advertisedOptions = Array.isArray(meta?.configOptions) ? meta.configOptions : [];
  if (advertisedOptions.length === 0) return;

  for (const savedOption of savedOptions) {
    const advertisedOption = advertisedOptions.find(option => option.id === savedOption?.id);
    if (!isConfigValueAdvertised(savedOption, advertisedOption)) continue;

    try {
      const result = await setProviderConfigOption(acpClient, providerModule, sessionId, savedOption.id, savedOption.currentValue);
      if (result === null) continue;

      const optionsFromResult = getConfigOptionsFromSetResult(result, savedOption.id, savedOption.currentValue, providerModule);
      const updatedOptions = mergeConfigOptions(meta.configOptions, optionsFromResult);
      meta.configOptions = updatedOptions;
      if (typeof db.saveConfigOptions === 'function') {
        await db.saveConfigOptions(sessionId, optionsFromResult);
      }
    } catch (err) {
      writeLog(`[OPTION ERR] Failed to reapply ${savedOption.id} for ${sessionId}: ${err.message}`);
    }
  }
}

export function getKnownModelOptions(session, meta, providerModels) {
  return mergeModelOptions(
    mergeModelOptions(session?.modelOptions, meta?.modelOptions),
    modelOptionsFromProviderConfig(providerModels)
  );
}

export function updateSessionModelMetadata(acpClient, sessionId, modelState = {}) {
  const meta = acpClient.sessionMetadata.get(sessionId);
  if (!meta) return modelState;

  const modelOptions = modelState.replaceModelOptions
    ? modelState.modelOptions
    : mergeModelOptions(meta.modelOptions, modelState.modelOptions);
  const currentModelId = modelState.currentModelId || meta.currentModelId || meta.model || null;

  meta.modelOptions = modelOptions;
  if (currentModelId) {
    meta.currentModelId = currentModelId;
    meta.model = currentModelId;
  }

  return { currentModelId, modelOptions };
}

function normalizeProviderModelState(providerModule, modelState, source) {
  return providerModule.normalizeModelState(modelState, source);
}

export async function setSessionModel(acpClient, sessionId, selection, providerModels, modelOptions) {
  const resolved = resolveModelSelection(selection, providerModels, modelOptions);
  if (!resolved.modelId) {
    const currentState = updateSessionModelMetadata(acpClient, sessionId, { modelOptions });
    if (typeof db.saveModelState === 'function') {
      await db.saveModelState(sessionId, currentState);
    }
    return {
      ...currentState,
      model: resolved.modelKey
    };
  }
  writeLog(`[ACP] Setting session ${sessionId} model to ${resolved.modelKey} (${resolved.modelId})`);

  const result = await acpClient.transport.sendRequest('session/set_model', {
    sessionId,
    modelId: resolved.modelId
  });

  const providerModule = await getProviderModule(acpClient.getProviderId?.());
  const extracted = normalizeProviderModelState(
    providerModule,
    extractModelState(result || {}, providerModels, resolved.modelId),
    result || {}
  );
  const meta = acpClient.sessionMetadata.get(sessionId);
  const modelState = {
    currentModelId: extracted.currentModelId || meta?.currentModelId || meta?.model || null,
    modelOptions: extracted.replaceModelOptions
      ? extracted.modelOptions
      : mergeModelOptions(meta?.modelOptions, extracted.modelOptions),
    replaceModelOptions: extracted.replaceModelOptions
  };

  const finalState = updateSessionModelMetadata(acpClient, sessionId, {
    ...modelState,
    currentModelId: modelState.currentModelId || resolved.modelId
  });
  
  if (typeof db.saveModelState === 'function') {
    await db.saveModelState(sessionId, finalState);
  }

  return {
    ...finalState,
    model: resolved.modelKey
  };
}

export async function loadSessionIntoMemory(acpClient, dbSession) {
  const providerId = acpClient.getProviderId();
  const provider = getProvider(providerId);
  const { models } = provider.config;
  const sessionId = dbSession.acpSessionId;
  const providerModule = await getProviderModule(providerId);
  const sessionParams = providerModule.buildSessionParams();

  writeLog(`[SESSION] Hot-loading session ${dbSession.id} (${sessionId}) for provider ${providerId}`);

  // Initialize metadata
  if (!acpClient.sessionMetadata.has(sessionId)) {
    const knownModelOptions = getKnownModelOptions(dbSession, null, models);
    const resolvedModel = resolveModelSelection(dbSession.currentModelId || dbSession.model, models, knownModelOptions);
    acpClient.sessionMetadata.set(sessionId, {
      model: resolvedModel.modelId,
      currentModelId: resolvedModel.modelId,
      modelOptions: knownModelOptions,
      toolCalls: 0,
      successTools: 0,
      startTime: Date.now(),
      usedTokens: Number(dbSession.stats?.usedTokens || 0),
      totalTokens: Number(dbSession.stats?.totalTokens || 0),
      promptCount: 0,
      lastResponseBuffer: '',
      lastThoughtBuffer: '',
      agentName: null,
      spawnContext: null,
      configOptions: dbSession.configOptions,
      provider: providerId
    });
  }

  acpClient.stream.beginDraining(sessionId);
  const mcpServers = getMcpServers(providerId, { acpSessionId: sessionId });
  const result = await acpClient.transport.sendRequest('session/load', {
    sessionId,
    cwd: dbSession.cwd || process.cwd(),
    mcpServers,
    ...sessionParams
  });
  bindMcpProxy(getMcpProxyIdFromServers(mcpServers), { providerId, acpSessionId: sessionId });
  await acpClient.stream.waitForDrainToFinish(sessionId, 1500);
  emitCachedContext(providerModule, sessionId);

  // Capture advertised model state from load response
  const extracted = normalizeProviderModelState(
    providerModule,
    extractModelState(result || {}, models, dbSession.currentModelId || dbSession.model),
    result || {}
  );
  const meta = acpClient.sessionMetadata.get(sessionId);
  const modelState = {
    currentModelId: extracted.currentModelId || meta?.currentModelId || meta?.model || null,
    modelOptions: extracted.replaceModelOptions
      ? extracted.modelOptions
      : mergeModelOptions(meta?.modelOptions, extracted.modelOptions),
    replaceModelOptions: extracted.replaceModelOptions
  };
  const updated = updateSessionModelMetadata(acpClient, sessionId, modelState);
  if (typeof db.saveModelState === 'function') {
    await db.saveModelState(sessionId, updated);
  }

  const configOptions = normalizeProviderConfigOptions(providerModule, result?.configOptions);
  if (configOptions.length > 0 && meta) {
    meta.configOptions = mergeConfigOptions(meta.configOptions, configOptions);
    if (typeof db.saveConfigOptions === 'function') {
      await db.saveConfigOptions(providerId, sessionId, configOptions);
    }
  }

  // Re-apply model and config options
  const knownModelOptions = getKnownModelOptions(dbSession, acpClient.sessionMetadata.get(sessionId), models);
  await setSessionModel(acpClient, sessionId, dbSession.currentModelId || dbSession.model, models, knownModelOptions);
  await reapplySavedConfigOptions(acpClient, sessionId, dbSession.configOptions, providerModule);
  
  writeLog(`[SESSION] Session ${dbSession.id} is now hot-loaded.`);
}

export async function autoLoadPinnedSessions(acpClient) {
  const providerId = acpClient.getProviderId();
  try {
    const pinnedSessions = await db.getPinnedSessions(providerId);
    if (pinnedSessions.length === 0) {
      writeLog(`[SESSION] No pinned sessions to auto-load for provider ${providerId}`);
      return;
    }

    writeLog(`[SESSION] Auto-loading ${pinnedSessions.length} pinned sessions for provider ${providerId}`);
    
    // Load sessions sequentially to avoid overloading the daemon/provider
    for (const session of pinnedSessions) {
      try {
        await loadSessionIntoMemory(acpClient, session);
      } catch (err) {
        writeLog(`[SESSION ERR] Failed to auto-load pinned session ${session.id}: ${err.message}`);
      }
    }
  } catch (err) {
    writeLog(`[SESSION ERR] autoLoadPinnedSessions failed for provider ${providerId}: ${err.message}`);
  }
}

export function findSessionFiles(_sessionId) {
  // Stub — session file discovery not implemented
  return [];
}

export async function autoSaveTurn(sessionId, acpClient = null) {
  try {
    // Wait for any final tool call/token updates from the AI process to settle
    await new Promise(r => setTimeout(r, 5000));

    // Don't force-complete if a permission request is pending
    if (acpClient?.permissions?.pendingPermissions?.has(sessionId)) {
      writeLog(`[DB] Skipping auto-save for ${sessionId} — permission request pending`);
      return;
    }

    const providerId = acpClient?.getProviderId?.() || acpClient?.providerId || null;
    const session = providerId
      ? await db.getSessionByAcpId(providerId, sessionId)
      : await db.getSessionByAcpId(sessionId);
    const meta = acpClient?.sessionMetadata?.get(sessionId);
    
    if (session && session.messages && session.messages.length > 0) {
      const lastMsg = session.messages[session.messages.length - 1];
      let statsChanged = false;

      // Update configOptions from memory if available
      if (meta?.configOptions) {
        session.configOptions = meta.configOptions;
      }
      if (meta?.currentModelId) {
        session.currentModelId = meta.currentModelId;
      }
      if (meta?.modelOptions) {
        session.modelOptions = meta.modelOptions;
      }
      if (meta) {
        const prevUsed = Number(session.stats?.usedTokens || 0);
        const prevTotal = Number(session.stats?.totalTokens || 0);
        const nextUsed = Number(meta.usedTokens || 0);
        const nextTotal = Number(meta.totalTokens || 0);
        statsChanged = prevUsed !== nextUsed || prevTotal !== nextTotal;
        session.stats = {
          sessionId,
          sessionPath: session.stats?.sessionPath || 'Relative',
          model: meta.currentModelId || meta.model || session.model || session.stats?.model || 'Unknown',
          toolCalls: Number(meta.toolCalls || session.stats?.toolCalls || 0),
          successTools: Number(meta.successTools || session.stats?.successTools || 0),
          durationMs: Number((Date.now() - Number(meta.startTime || Date.now())) || 0),
          usedTokens: nextUsed,
          totalTokens: nextTotal,
          sessionSizeMb: Number(((nextUsed * 4) / (1024 * 1024)).toFixed(2))
        };
      }

      // Only save if it's still in a streaming state in the DB
      if (lastMsg.role === 'assistant' && lastMsg.isStreaming) {
        writeLog(`[DB] Auto-completing turn for disconnected UI: ${sessionId}`);
        lastMsg.isStreaming = false;
        
        // If the message is completely empty, it means the UI never sent ANY updates. 
        // We don't want to save an empty bubble as 'finished' because that's non-recoverable.
        if (lastMsg.content || (lastMsg.timeline && lastMsg.timeline.length > 0)) {
          await db.saveSession(session);
        }
      } else if (statsChanged) {
        await db.saveSession(session);
      }
    }
  } catch (e) {
    writeLog(`[DB ERR] Auto-save failed: ${e.message}`);
  }
}

