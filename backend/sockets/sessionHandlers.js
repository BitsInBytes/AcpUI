import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { writeLog } from '../services/logger.js';
import * as db from '../database.js';
import { providerRuntimeManager } from '../services/providerRuntimeManager.js';
import { getAttachmentsRoot } from '../services/attachmentVault.js';
import { getProvider, getProviderModule } from '../services/providerLoader.js';
import { parseJsonlSession } from '../services/jsonlParser.js';
import { cleanupAcpSession } from '../mcp/acpCleanup.js';
import { runHooks } from '../services/hookRunner.js';
import { generateForkTitle } from '../services/acpTitleGenerator.js';
import { mergeConfigOptions } from '../services/configOptions.js';
import {
  extractModelState,
  mergeModelOptions,
  modelOptionsFromProviderConfig,
  resolveModelSelection
} from '../services/modelOptions.js';
import {
  getMcpServers,
  reapplySavedConfigOptions,
  getKnownModelOptions,
  updateSessionModelMetadata,
  setSessionModel,
  setProviderConfigOption,
  getConfigOptionsFromSetResult,
  normalizeProviderConfigOptions
} from '../services/sessionManager.js';
import { bindMcpProxy, getMcpProxyIdFromServers } from '../mcp/mcpProxyRegistry.js';

async function saveModelState(sessionId, modelState) {
  if (typeof db.saveModelState === 'function') {
    await db.saveModelState(sessionId, modelState);
  }
}

async function captureModelState(acpClient, sessionId, source, providerModels, fallbackSelection, providerModule = null) {
  const rawModelState = extractModelState(source, providerModels, fallbackSelection);
  const extracted = providerModule.normalizeModelState(rawModelState, source);
  const meta = acpClient.sessionMetadata.get(sessionId);
  const modelState = {
    currentModelId: extracted.currentModelId || meta?.currentModelId || meta?.model || null,
    modelOptions: extracted.replaceModelOptions
      ? extracted.modelOptions
      : mergeModelOptions(meta?.modelOptions, extracted.modelOptions)
  };

  const updated = updateSessionModelMetadata(acpClient, sessionId, modelState);
  await saveModelState(sessionId, updated);

  const configOptions = normalizeProviderConfigOptions(providerModule, source?.configOptions);
  if (configOptions.length > 0 && meta) {
    meta.configOptions = mergeConfigOptions(meta.configOptions, configOptions);
    if (typeof db.saveConfigOptions === 'function') {
      const providerId = acpClient.getProviderId?.() || meta.provider;
      await db.saveConfigOptions(providerId, sessionId, configOptions);
    }
  }

  return updated;
}

const loadingSessions = new Set();

function emitCachedContext(providerModule, sessionId) {
  if (!sessionId) return;
  try {
    providerModule.emitCachedContext(sessionId);
  } catch (err) {
    writeLog(`[SESSION] Failed to emit cached context for ${sessionId}: ${err.message}`);
  }
}

export default function registerSessionHandlers(io, socket) {
  socket.on('get_notes', async ({ sessionId }, callback) => {
    try {
      const notes = await db.getNotes(sessionId);
      callback?.({ notes });
    } catch (err) {
      callback?.({ notes: '', error: err.message });
    }
  });

  socket.on('save_notes', async ({ sessionId, notes }, callback) => {
    try {
      await db.saveNotes(sessionId, notes);
      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: err.message });
    }
  });

  socket.on('load_sessions', async (...args) => {
    const callback = args.pop();
    const payload = args[0] || {};
    let providerId = null;
    let providerAliases = [];
    if (payload.providerId) {
      const provider = getProvider(payload.providerId);
      providerId = provider.id;
      providerAliases = [provider.config.name, provider.config.branding?.assistantName].filter(alias => alias && alias !== providerId);
    }
    try {
      const allSessions = await db.getAllSessions(providerId, { providerAliases });
      const emptyNewChats = allSessions.filter(s => s.name === 'New Chat');
      
      if (emptyNewChats.length > 1) {
        for (let i = 1; i < emptyNewChats.length; i++) {
          await db.deleteSession(emptyNewChats[i].id);
        }
      }

      const sessions = await db.getAllSessions(providerId, { providerAliases });
      callback({ sessions });
    } catch (err) {
      writeLog(`[DB ERR] load_sessions failed: ${err.message}`);
      callback({ error: err.message });
    }
  });

  socket.on('get_session_history', async ({ uiId }, callback) => {
    try {
      const session = await db.getSession(uiId);
      if (session?.acpSessionId) {
        const jsonlMessages = await parseJsonlSession(session.acpSessionId, session.provider);
        if (jsonlMessages && jsonlMessages.length > (session.messages?.length || 0)) {
          session.messages = jsonlMessages;
          await db.saveSession(session);
        }
      }
      callback({ session });
    } catch (err) {
      writeLog(`[DB ERR] get_session_history failed: ${err.message}`);
      callback({ error: err.message });
    }
  });

  socket.on('rehydrate_session', async ({ uiId }, callback) => {
    try {
      const session = await db.getSession(uiId);
      if (!session?.acpSessionId) {
        return callback?.({ error: 'No ACP session ID — nothing to rehydrate from' });
      }
      const jsonlMessages = await parseJsonlSession(session.acpSessionId, session.provider);
      if (!jsonlMessages) {
        return callback?.({ error: 'JSONL file not found or could not be parsed' });
      }
      session.messages = jsonlMessages;
      await db.saveSession(session);
      callback?.({ success: true, messageCount: jsonlMessages.length });
    } catch (err) {
      writeLog(`[DB ERR] rehydrate_session failed: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('save_snapshot', async (session) => {
    try {
      const provider = getProvider(session.provider || null);
      const providerId = provider.id;
      await db.saveSession({ ...session, provider: providerId });
    } catch (err) {
      writeLog(`[DB ERR] Failed to save snapshot: ${err.message}`);
    }
  });

  socket.on('delete_session', async ({ uiId }) => {
    try {
      const session = await db.getSession(uiId);
      if (!session) return;
      const pid = session.provider || getProvider().id;

      const sessionDir = path.join(getAttachmentsRoot(pid), uiId);
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

      if (session.acpSessionId) {
        await cleanupAcpSession(session.acpSessionId, pid, 'user-delete-main');
      }

      await db.deleteSession(uiId);
      const allSessions = await db.getAllSessions();
      const descendants = [];
      const collectDescendants = (parentId) => {
        for (const s of allSessions) {
          if (s.forkedFrom === parentId) { descendants.push(s); collectDescendants(s.id); }
        }
      };
      collectDescendants(uiId);
      for (const child of descendants) {
        const cpid = child.provider || pid;
        if (child.acpSessionId) {
          await cleanupAcpSession(child.acpSessionId, cpid, 'user-delete-child');
        }
        const childAttach = path.join(getAttachmentsRoot(cpid), child.id);
        if (fs.existsSync(childAttach)) fs.rmSync(childAttach, { recursive: true, force: true });
        await db.deleteSession(child.id);
      }
    } catch (err) {
      writeLog(`[DB ERR] Failed to delete session: ${err.message}`);
    }
  });

  socket.on('open_in_editor', ({ filePath }) => {
    if (!filePath) return;
    exec(`code "${filePath}"`, (err) => {
      if (err) writeLog(`[EDITOR ERR] ${err.message}`);
    });
  });

  socket.on('fork_session', async ({ uiId, messageIndex }, callback) => {
    try {
      const session = await db.getSession(uiId);
      if (!session) return callback?.({ error: 'Session not found' });
      const providerId = session.provider || getProvider().id;
      const runtime = providerRuntimeManager.getRuntime(providerId);
      const acpClient = runtime.client;
      const providerModule = await getProviderModule(providerId);

      const crypto = await import('crypto');
      const newAcpId = crypto.randomUUID();
      const newUiId = `fork-${Date.now()}`;
      const oldAcpId = session.acpSessionId;

      providerModule.cloneSession(oldAcpId, newAcpId, Math.ceil((messageIndex + 1) / 2));

      const oldAttach = path.join(getAttachmentsRoot(providerId), uiId);
      if (fs.existsSync(oldAttach)) {
        fs.cpSync(oldAttach, path.join(getAttachmentsRoot(providerId), newUiId), { recursive: true });
      }

      const forkedMessages = (session.messages || []).slice(0, messageIndex + 1);
      await db.saveSession({
        id: newUiId, acpSessionId: newAcpId, name: `${session.name} (fork)`,
        model: session.model, messages: forkedMessages, isPinned: false,
        cwd: session.cwd, folderId: session.folderId, forkedFrom: uiId,
        forkPoint: messageIndex, currentModelId: session.currentModelId,
        modelOptions: session.modelOptions, provider: providerId,
      });

      acpClient.stream.beginDraining(newAcpId);
      const forkMcpServers = getMcpServers(providerId, { acpSessionId: newAcpId });
      await acpClient.transport.sendRequest('session/load', {
        sessionId: newAcpId, cwd: session.cwd || process.cwd(),
        mcpServers: forkMcpServers
      });
      await acpClient.stream.waitForDrainToFinish(newAcpId, 3000);

      const { models: forkModels } = getProvider(providerId).config;
      const knownModelOptions = getKnownModelOptions(session, null, forkModels);
      const resolvedModel = resolveModelSelection(session.currentModelId || session.model, forkModels, knownModelOptions);

      acpClient.sessionMetadata.set(newAcpId, {
        model: resolvedModel.modelId, currentModelId: resolvedModel.modelId,
        modelOptions: knownModelOptions, toolCalls: 0, successTools: 0, startTime: Date.now(),
        usedTokens: Number(session.stats?.usedTokens || 0), totalTokens: Number(session.stats?.totalTokens || 0), promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '',
        agentName: null, spawnContext: null, provider: runtime.providerId, configOptions: session.configOptions
      });

      callback?.({
        success: true, providerId: runtime.providerId, newUiId, newAcpId,
        currentModelId: resolvedModel.modelId, modelOptions: knownModelOptions, configOptions: session.configOptions
      });

      generateForkTitle(acpClient, newUiId, session.messages || [], messageIndex).catch(() => {});
    } catch (err) {
      writeLog(`[FORK ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('create_session', async ({ providerId, model, existingAcpId, cwd: requestCwd, agent: requestAgent }, callback) => {
    if (existingAcpId && loadingSessions.has(existingAcpId)) {
      writeLog(`[SESSION] session ${existingAcpId} already loading; skipping duplicate request`);
      return;
    }
    if (existingAcpId) loadingSessions.add(existingAcpId);

    try {
      const runtime = providerRuntimeManager.getRuntime(providerId);
      const acpClient = runtime.client;
      if (!acpClient.isHandshakeComplete) return callback({ error: 'Daemon not ready' });

      const resolvedProviderId = runtime.providerId;
      const provider = getProvider(resolvedProviderId);
      const { models } = provider.config;
      const sessionCwd = requestCwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
      writeLog(`[SESSION] create_session CWD: ${sessionCwd} (requestCwd=${requestCwd}, DEFAULT_WORKSPACE_CWD=${process.env.DEFAULT_WORKSPACE_CWD})`);
      const providerModule = await getProviderModule(resolvedProviderId);
      const sessionParams = providerModule.buildSessionParams(requestAgent);

      let result;
      let dbSession = null;
      let selectedModelState;

      if (existingAcpId) {
        dbSession = await db.getSessionByAcpId(resolvedProviderId, existingAcpId);
        
        // If the session is already hot-loaded (handshake done and metadata exists), 
        // skip the expensive ACP session/load call and just return the state.
        if (acpClient.sessionMetadata.has(existingAcpId)) {
          writeLog(`[SESSION] Skipping load for hot session: ${existingAcpId}`);
          result = { sessionId: existingAcpId };
          const meta = acpClient.sessionMetadata.get(existingAcpId);
          if (dbSession?.stats) {
            if ((Number(meta.usedTokens || 0) === 0) && Number(dbSession.stats.usedTokens || 0) > 0) {
              meta.usedTokens = Number(dbSession.stats.usedTokens || 0);
            }
            if ((Number(meta.totalTokens || 0) === 0) && Number(dbSession.stats.totalTokens || 0) > 0) {
              meta.totalTokens = Number(dbSession.stats.totalTokens || 0);
            }
          }
          selectedModelState = {
            model: meta.model,
            currentModelId: meta.currentModelId,
            modelOptions: meta.modelOptions,
            configOptions: meta.configOptions
          };
          emitCachedContext(providerModule, existingAcpId);
        } else {
          if (dbSession) {
            const knownModelOptions = getKnownModelOptions(dbSession, null, models);
            const resolvedModel = resolveModelSelection(dbSession.currentModelId || dbSession.model || model, models, knownModelOptions);
            acpClient.sessionMetadata.set(existingAcpId, {
              model: resolvedModel.modelId, currentModelId: resolvedModel.modelId,
modelOptions: knownModelOptions, toolCalls: 0, successTools: 0, startTime: Date.now(),
              usedTokens: Number(dbSession.stats?.usedTokens || 0), totalTokens: Number(dbSession.stats?.totalTokens || 0), promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '',
              agentName: requestAgent || null, spawnContext: null,
              configOptions: dbSession.configOptions, provider: resolvedProviderId
            });
          }
          acpClient.stream.beginDraining(existingAcpId);
          const loadMcpServers = getMcpServers(resolvedProviderId, { acpSessionId: existingAcpId });
          result = await acpClient.transport.sendRequest('session/load', {
            sessionId: existingAcpId, cwd: sessionCwd, mcpServers: loadMcpServers, ...sessionParams
          });
          await acpClient.stream.waitForDrainToFinish(existingAcpId, 1500);
          if (!result.sessionId) result.sessionId = existingAcpId;
          await captureModelState(acpClient, result.sessionId, result, models, model || dbSession?.currentModelId || dbSession?.model, providerModule);
          emitCachedContext(providerModule, result.sessionId);
          const knownModelOptions = getKnownModelOptions(dbSession, acpClient.sessionMetadata.get(result.sessionId), models);
          selectedModelState = await setSessionModel(acpClient, result.sessionId, model || dbSession?.currentModelId || dbSession?.model, models, knownModelOptions);
          await reapplySavedConfigOptions(acpClient, result.sessionId, dbSession?.configOptions, providerModule);
          if (requestAgent) await providerModule.setInitialAgent(acpClient, result.sessionId, requestAgent);
        }
      } else {
        const initialModelOptions = modelOptionsFromProviderConfig(models);
        const requestedModel = resolveModelSelection(model, models, initialModelOptions);
        acpClient.sessionMetadata.set('pending-new', {
          model: requestedModel.modelId, currentModelId: requestedModel.modelId,
          modelOptions: initialModelOptions, toolCalls: 0, successTools: 0, startTime: Date.now(),
          usedTokens: 0, totalTokens: 0, promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '',
          agentName: requestAgent || null, spawnContext: null, provider: resolvedProviderId
        });
        const newMcpServers = getMcpServers(resolvedProviderId);
        result = await acpClient.transport.sendRequest('session/new', {
          cwd: sessionCwd, mcpServers: newMcpServers, ...sessionParams
        });
        bindMcpProxy(getMcpProxyIdFromServers(newMcpServers), { providerId: resolvedProviderId, acpSessionId: result.sessionId });
        const meta = acpClient.sessionMetadata.get('pending-new');
        acpClient.sessionMetadata.delete('pending-new');
        acpClient.sessionMetadata.set(result.sessionId, meta);
        await captureModelState(acpClient, result.sessionId, result, models, requestedModel.modelId, providerModule);
        await providerModule.setInitialAgent(acpClient, result.sessionId, requestAgent);
        const knownModelOptions = getKnownModelOptions(null, acpClient.sessionMetadata.get(result.sessionId), models);
        selectedModelState = await setSessionModel(acpClient, result.sessionId, model || requestedModel.modelId, models, knownModelOptions);
      }

      const finalMeta = acpClient.sessionMetadata.get(result.sessionId);
      if (requestAgent) {
        const outputs = await runHooks(requestAgent, 'session_start', { cwd: sessionCwd, sessionId: result.sessionId }, { io, sessionId: result.sessionId, providerId: resolvedProviderId });
        const context = outputs.filter(o => o).join('\n\n');
        if (context && finalMeta) finalMeta.spawnContext = context;
      }

      callback({
        success: true, providerId: resolvedProviderId, acpSessionId: result.sessionId, sessionId: result.sessionId,
        model: selectedModelState?.model || model,
        currentModelId: finalMeta?.currentModelId || selectedModelState?.currentModelId,
        modelOptions: finalMeta?.modelOptions || selectedModelState?.modelOptions,
        configOptions: finalMeta?.configOptions
      });
    } catch (err) {
      writeLog(`[ACP ERR] create_session failed: ${err.message}`);
      callback({ error: err.message });
    } finally {
      if (existingAcpId) loadingSessions.delete(existingAcpId);
    }
  });

  socket.on('export_session', async ({ uiId, exportPath }, callback) => {
    try {
      const session = await db.getSession(uiId);
      if (!session) return callback?.({ error: 'Session not found' });
      const pid = session.provider || getProvider().id;
      const exportDir = path.resolve(exportPath, session.name.replace(/[<>:"/\\|?*]/g, '_'));
      fs.mkdirSync(exportDir, { recursive: true });
      fs.writeFileSync(path.join(exportDir, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
      const providerModule = await getProviderModule(pid);
      const { jsonl: jsonlPath } = providerModule.getSessionPaths(session.acpSessionId);
      if (jsonlPath && fs.existsSync(jsonlPath)) fs.copyFileSync(jsonlPath, path.join(exportDir, `${session.acpSessionId}.jsonl`));
      const attachDir = path.join(getAttachmentsRoot(pid), uiId);
      if (fs.existsSync(attachDir)) {
        const destAttach = path.join(exportDir, 'attachments');
        fs.mkdirSync(destAttach, { recursive: true });
        for (const file of fs.readdirSync(attachDir)) fs.copyFileSync(path.join(attachDir, file), path.join(destAttach, file));
      }
      callback?.({ success: true, exportDir });
    } catch (err) {
      writeLog(`[EXPORT ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('merge_fork', async ({ uiId }, callback) => {
    try {
      const forkSession = await db.getSession(uiId);
      if (!forkSession?.forkedFrom || !forkSession.acpSessionId) return callback?.({ error: 'Not a valid fork session' });
      const parentSession = await db.getSession(forkSession.forkedFrom);
      if (!parentSession?.acpSessionId) return callback?.({ error: 'Parent session not found' });
      const pid = forkSession.provider || getProvider().id;
      const acpClient = providerRuntimeManager.getClient(pid);

      acpClient.stream.statsCaptures.set(forkSession.acpSessionId, { buffer: '' });
      await acpClient.transport.sendRequest('session/prompt', {
        sessionId: forkSession.acpSessionId,
        prompt: [{ type: 'text', text: 'Create a highly detailed summary of everything you have done since the most recent fork, so you can inform the parent chat of your work.' }]
      });
      const summary = acpClient.stream.statsCaptures.get(forkSession.acpSessionId)?.buffer?.trim() || '(No summary generated)';
      acpClient.stream.statsCaptures.delete(forkSession.acpSessionId);
      await cleanupAcpSession(forkSession.acpSessionId, pid, 'fork-merge');
      await db.deleteSession(uiId);
      callback?.({ success: true, parentUiId: forkSession.forkedFrom });

      setTimeout(async () => {
        try {
          const mergeMessage = `A forked child agent is informing you of their work:\n\n${summary}`;
          io.to(`session:${parentSession.acpSessionId}`).emit('merge_message', { sessionId: parentSession.acpSessionId, text: mergeMessage });
          await acpClient.transport.sendRequest('session/prompt', { sessionId: parentSession.acpSessionId, prompt: [{ type: 'text', text: mergeMessage }] });
          io.to(`session:${parentSession.acpSessionId}`).emit('token_done', { sessionId: parentSession.acpSessionId });
        } catch (err) {
          writeLog(`[MERGE ERR] ${err.message}`);
        }
      }, 1000);
    } catch (err) {
      writeLog(`[MERGE ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('set_session_option', async ({ uiId, optionId, value }) => {
    try {
      const session = (await db.getAllSessions()).find(s => s.id === uiId);
      if (!session || !session.acpSessionId) return;
      const pid = session.provider || getProvider().id;
      const acpClient = providerRuntimeManager.getClient(pid);
      const providerModule = await getProviderModule(pid);
      const result = await setProviderConfigOption(acpClient, providerModule, session.acpSessionId, optionId, value);
      if (result === null) return;
      const optionsFromResult = getConfigOptionsFromSetResult(result, optionId, value, providerModule);
      const meta = acpClient.sessionMetadata.get(session.acpSessionId);
      if (meta) meta.configOptions = mergeConfigOptions(meta.configOptions, optionsFromResult);
      await db.saveConfigOptions(session.acpSessionId, optionsFromResult);
    } catch (err) {
      writeLog(`[OPTION ERR] ${err.message}`);
    }
  });

  socket.on('set_session_model', async ({ uiId, model }, callback) => {
    try {
      const session = await db.getSession(uiId);
      if (!session || !session.acpSessionId) return;
      const pid = session.provider || getProvider().id;
      const acpClient = providerRuntimeManager.getClient(pid);
      const { models } = getProvider(pid).config;
      const meta = acpClient.sessionMetadata.get(session.acpSessionId);
      const knownModelOptions = getKnownModelOptions(session, meta, models);
      const selectedModelState = await setSessionModel(acpClient, session.acpSessionId, model, models, knownModelOptions);
      session.model = selectedModelState.model;
      session.currentModelId = selectedModelState.currentModelId;
      session.modelOptions = selectedModelState.modelOptions;
      await db.saveSession(session);
      callback?.({
        success: true, providerId: pid, model: selectedModelState.model,
        currentModelId: selectedModelState.currentModelId,
        modelOptions: selectedModelState.modelOptions, configOptions: selectedModelState.configOptions
      });
    } catch (err) {
      writeLog(`[SESSION ERR] Failed to switch model: ${err.message}`);
      callback?.({ error: err.message });
    }
  });
}
