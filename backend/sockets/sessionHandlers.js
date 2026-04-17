import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { writeLog } from '../services/logger.js';
import * as db from '../database.js';
import acpClient from '../services/acpClient.js';
import { getAttachmentsRoot } from '../services/attachmentVault.js';
import { getProvider, getProviderModule } from '../services/providerLoader.js';
import { parseJsonlSession } from '../services/jsonlParser.js';
import { cleanupAcpSession } from '../mcp/acpCleanup.js';
import { runHooks } from '../services/hookRunner.js';
import { generateForkTitle } from '../services/acpTitleGenerator.js';
import { mergeConfigOptions } from '../services/configOptions.js';

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

async function setProviderConfigOption(providerModule, sessionId, optionId, value) {
  if (typeof providerModule.setConfigOption === 'function') {
    await providerModule.setConfigOption(acpClient, sessionId, optionId, value);
    return true;
  }
  if (typeof acpClient.setConfigOption === 'function') {
    await acpClient.setConfigOption(sessionId, optionId, value);
    return true;
  }
  return false;
}

async function reapplySavedConfigOptions(sessionId, savedOptions, providerModule) {
  if (!Array.isArray(savedOptions) || savedOptions.length === 0) return;

  const meta = acpClient.sessionMetadata.get(sessionId);
  const advertisedOptions = Array.isArray(meta?.configOptions) ? meta.configOptions : [];
  if (advertisedOptions.length === 0) return;

  for (const savedOption of savedOptions) {
    const advertisedOption = advertisedOptions.find(option => option.id === savedOption?.id);
    if (!isConfigValueAdvertised(savedOption, advertisedOption)) continue;

    try {
      const didSet = await setProviderConfigOption(providerModule, sessionId, savedOption.id, savedOption.currentValue);
      if (!didSet) continue;

      const updatedOptions = mergeConfigOptions(meta.configOptions, [{ id: savedOption.id, currentValue: savedOption.currentValue }]);
      meta.configOptions = updatedOptions;
      if (typeof db.saveConfigOptions === 'function') {
        await db.saveConfigOptions(sessionId, [{ id: savedOption.id, currentValue: savedOption.currentValue }]);
      }
    } catch (err) {
      writeLog(`[OPTION ERR] Failed to reapply ${savedOption.id} for ${sessionId}: ${err.message}`);
    }
  }
}

// Returns MCP server configs in stdio transport format (command + args) because
// ACP spawns each server as a child process — the proxy bridges to our SSE backend
function getMcpServers() {
  const name = getProvider().config.mcpName;
  if (!name) return [];
  const proxyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'stdio-proxy.js');
  return [{
    name,
    command: 'node',
    args: [proxyPath],
    env: [
      { name: 'BACKEND_PORT', value: String(process.env.BACKEND_PORT || 3005) },
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
    ]
  }];
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

  socket.on('load_sessions', async (callback) => {
    const providerName = getProvider().config.name;
    writeLog(`[DB] Client ${socket.id} requested load_sessions for provider: ${providerName}`);
    try {
      const allSessions = await db.getAllSessions(providerName);
      const emptyNewChats = allSessions.filter(s => s.name === 'New Chat');
      
      if (emptyNewChats.length > 1) {
        writeLog(`[DB] Cleaning up ${emptyNewChats.length - 1} duplicate empty New Chats...`);
        for (let i = 1; i < emptyNewChats.length; i++) {
          await db.deleteSession(emptyNewChats[i].id);
        }
      }

      const sessions = await db.getAllSessions(providerName);
      writeLog(`[DB] load_sessions returned ${sessions.length} sessions.`);
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
        // JSONL is the source of truth (written by ACP); DB may lag behind if a save was missed.
        // If JSONL has more messages, rebuild DB from it to avoid losing conversation turns.
        const jsonlMessages = await parseJsonlSession(session.acpSessionId);
        if (jsonlMessages && jsonlMessages.length > (session.messages?.length || 0)) {
          writeLog(`[DB] JSONL has ${jsonlMessages.length} messages vs DB ${(session.messages?.length || 0)} for ${uiId} — rebuilding from JSONL`);
          session.messages = jsonlMessages;
          await db.saveSession(session);
        }
      }
      callback({ session });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  socket.on('rehydrate_session', async ({ uiId }, callback) => {
    try {
      const session = await db.getSession(uiId);
      if (!session?.acpSessionId) {
        return callback?.({ error: 'No ACP session ID — nothing to rehydrate from' });
      }
      const jsonlMessages = await parseJsonlSession(session.acpSessionId);
      if (!jsonlMessages) {
        return callback?.({ error: 'JSONL file not found or could not be parsed' });
      }
      session.messages = jsonlMessages;
      await db.saveSession(session);
      writeLog(`[DB] Rehydrated ${uiId} from JSONL: ${jsonlMessages.length} messages`);
      callback?.({ success: true, messageCount: jsonlMessages.length });
    } catch (err) {
      writeLog(`[DB ERR] rehydrate_session failed: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('save_snapshot', async (session) => {
    try {
      writeLog(`[DB] Saving snapshot for uiId: ${session.id}, name: ${session.name}`);
      await db.saveSession(session);
    } catch (err) {
      writeLog(`[DB ERR] Failed to save snapshot: ${err.message}`);
    }
  });

  socket.on('delete_session', async ({ uiId }) => {
    try {
      const session = await db.getSession(uiId);

      const sessionDir = path.join(getAttachmentsRoot(), uiId);
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

      // Clean up ACP session files (.jsonl, .json, tasks folder)
      // Delegated to providerModule via cleanupAcpSession to handle non-flat directory structures.
      if (session?.acpSessionId) {
        await cleanupAcpSession(session.acpSessionId);
      }

      await db.deleteSession(uiId);
      // Cascade delete: forks and sub-agents store a forkedFrom reference to their parent.
      // Without cascade, deleting a parent would orphan those children — leaving DB records,
      // ACP session files (.jsonl/.json/tasks), and attachments with no way to clean them up.
      const allSessions = await db.getAllSessions();
      const descendants = [];
      const collectDescendants = (parentId) => {
        for (const s of allSessions) {
          if (s.forkedFrom === parentId) { descendants.push(s); collectDescendants(s.id); }
        }
      };
      collectDescendants(uiId);
      for (const child of descendants) {
        writeLog(`[DB] Cascade deleting child session: ${child.id}`);
        if (child.acpSessionId) {
          await cleanupAcpSession(child.acpSessionId);
        }
        const childAttach = path.join(getAttachmentsRoot(), child.id);
        if (fs.existsSync(childAttach)) fs.rmSync(childAttach, { recursive: true, force: true });
        await db.deleteSession(child.id);
      }
      writeLog(`[DB] Deleted session: ${uiId}${descendants.length ? ` (+${descendants.length} descendants)` : ''}`);
    } catch (err) {
      writeLog(`[DB ERR] Failed to delete session: ${err.message}`);
    }
  });

  socket.on('open_in_editor', ({ filePath }) => {
    if (!filePath) return;
    exec(`code "${filePath}"`, (err) => {
      if (err) writeLog(`[EDITOR ERR] ${err.message}`);
      else writeLog(`[EDITOR] Opened ${filePath}`);
    });
  });

  socket.on('fork_session', async ({ uiId, messageIndex }, callback) => {
    try {
      const session = await db.getSession(uiId);
      if (!session) return callback?.({ error: 'Session not found' });

      const crypto = await import('crypto');
      const newAcpId = crypto.randomUUID();
      const newUiId = `fork-${Date.now()}`;
      const oldAcpId = session.acpSessionId;
      const providerModule = await getProviderModule();

      // 1-3. Clone session files via the provider.
      // The provider owns the knowledge of where and how session files are stored.
      providerModule.cloneSession(oldAcpId, newAcpId, Math.ceil((messageIndex + 1) / 2));

      // 4. Clone attachments
      const oldAttach = path.join(getAttachmentsRoot(), uiId);
      if (fs.existsSync(oldAttach)) {
        fs.cpSync(oldAttach, path.join(getAttachmentsRoot(), newUiId), { recursive: true });
      }

      // 5. Save forked session to DB
      // messageIndex is 0-based in the UI message array; +1 because slice end is exclusive.
      // This keeps all messages up to and including the fork point.
      const forkedMessages = (session.messages || []).slice(0, messageIndex + 1);
      await db.saveSession({
        id: newUiId,
        acpSessionId: newAcpId,
        name: `${session.name} (fork)`,
        model: session.model,
        messages: forkedMessages,
        isPinned: false,
        cwd: session.cwd,
        folderId: session.folderId,
        forkedFrom: uiId,
        forkPoint: messageIndex,
      });

      // 6. Load the cloned ACP session
      acpClient.beginDraining(newAcpId);
      await acpClient.sendRequest('session/load', {
        sessionId: newAcpId,
        cwd: session.cwd || process.cwd(),
        mcpServers: getMcpServers()
      });
      await acpClient.waitForDrainToFinish(newAcpId, 3000);

      // 7. Register ACP metadata so prompts work
      const { models: forkModels } = getProvider().config;
      const resolvedModelId = forkModels[session.model]?.id || forkModels.flagship.id;
      const currentProvider = getProvider().config.name;

      acpClient.sessionMetadata.set(newAcpId, {
        model: resolvedModelId, toolCalls: 0, successTools: 0, startTime: Date.now(),
        usedTokens: 0, totalTokens: 0, promptCount: 0,
        lastResponseBuffer: '', lastThoughtBuffer: '',
        agentName: null, spawnContext: null,
        provider: currentProvider,
        configOptions: session.configOptions
      });

      const meta = acpClient.sessionMetadata.get(newAcpId);
      writeLog(`[FORK] Forked ${uiId} → ${newUiId} (ACP: ${newAcpId}) at message ${messageIndex}`);
      callback?.({
        success: true,
        newUiId,
        newAcpId,
        configOptions: meta?.configOptions
      });

      // Generate a title for the forked session (async, don't block)
      generateForkTitle(acpClient, newUiId, session.messages || [], messageIndex).catch(err =>
        writeLog(`[FORK TITLE ERR] ${err.message}`)
      );
    } catch (err) {
      writeLog(`[FORK ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('create_session', async ({ model, existingAcpId, cwd: requestCwd, agent: requestAgent }, callback) => {
    writeLog(`[SESSION] create_session called: model=${model}, agent=${requestAgent}, cwd=${requestCwd}, existingAcpId=${existingAcpId}`);
    if (!acpClient.isHandshakeComplete) {
      return callback({ error: 'Daemon not ready' });
    }
    try {
      const { models } = getProvider().config;
      const modelId = models[model] ? model : 'flagship';

      const sessionCwd = requestCwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
      const currentProvider = getProvider().config.name;

      let result;
      let savedConfigOptionsForResume = [];
      if (existingAcpId) {
        writeLog(`[ACP] Resuming session: ${existingAcpId}`);

        const dbSession = await db.getSessionByAcpId(existingAcpId);
        savedConfigOptionsForResume = dbSession?.configOptions || [];

        // Ensure metadata is initialized with the current model from DB if we have it
        if (!acpClient.sessionMetadata.has(existingAcpId)) {
          if (dbSession) {
            const resolvedModelId = models[dbSession.model]?.id || dbSession.model;
            acpClient.sessionMetadata.set(existingAcpId, {
              model: resolvedModelId, toolCalls: 0, successTools: 0, startTime: Date.now(),
              usedTokens: 0, totalTokens: 0, promptCount: 0,
              lastResponseBuffer: '', lastThoughtBuffer: '',
              agentName: requestAgent || null, spawnContext: null,
              configOptions: dbSession.configOptions,
              provider: currentProvider
            });
          }
        }

        // session/load replays the full conversation history as events — drain suppresses
        // those from reaching the UI so the user doesn't see a flood of old messages
        acpClient.beginDraining(existingAcpId);

        result = await acpClient.sendRequest('session/load', {
          sessionId: existingAcpId,
          cwd: sessionCwd,
          mcpServers: getMcpServers()
        });

        writeLog(`[ACP] Waiting for history dump to drain...`);
        await acpClient.waitForDrainToFinish(existingAcpId, 1500);
        writeLog(`[ACP] Drain complete. Ready for prompts.`);

        if (!result.sessionId) result.sessionId = existingAcpId;
        result.reattached = true;

        const providerModule = await getProviderModule();
        await reapplySavedConfigOptions(result.sessionId, savedConfigOptionsForResume, providerModule);

        // Restore the agent — session/load does not preserve the active mode
        if (requestAgent) {
          await providerModule.setInitialAgent(acpClient, result.sessionId, requestAgent);
        }
      } else {
        writeLog(`[ACP] Creating new session with model: ${modelId}`);

        // Register metadata EARLY so async updates (like config_options) during creation can be captured
        acpClient.sessionMetadata.set('pending-new', {
          model: models.flagship.id, toolCalls: 0, successTools: 0, startTime: Date.now(),
          usedTokens: 0, totalTokens: 0, promptCount: 0,
          lastResponseBuffer: '', lastThoughtBuffer: '',
          agentName: requestAgent || null, spawnContext: null,
          provider: currentProvider
        });

        result = await acpClient.sendRequest('session/new', {
          cwd: sessionCwd,
          mcpServers: getMcpServers()
        });

        // Move metadata to the real session ID
        const meta = acpClient.sessionMetadata.get('pending-new');
        acpClient.sessionMetadata.delete('pending-new');
        acpClient.sessionMetadata.set(result.sessionId, meta);

        const providerModule = await getProviderModule();
        await providerModule.setInitialAgent(acpClient, result.sessionId, requestAgent);
      }

      const resolvedModelId = models[model]?.id || models.flagship.id;
      const finalMeta = acpClient.sessionMetadata.get(result.sessionId);
      if (finalMeta) finalMeta.model = resolvedModelId;

      // Sync the UI-selected model to the daemon immediately (don't wait for first prompt)
      if (!existingAcpId) {
        await acpClient.sendRequest('session/set_model', {
          sessionId: result.sessionId,
          modelId: resolvedModelId
        });
      }

      // Run session_start hooks and capture context before returning
      if (requestAgent) {
        const outputs = await runHooks(requestAgent, 'session_start', { cwd: sessionCwd, sessionId: result.sessionId }, { io, sessionId: result.sessionId });
        writeLog(`[HOOKS] session_start returned ${outputs.length} outputs: ${outputs.map(o => o.substring(0, 50)).join(', ')}`);
        const context = outputs.filter(o => o).join('\n\n');
        if (context && finalMeta) {
          finalMeta.spawnContext = context;
          writeLog(`[HOOKS] Captured agentSpawn context (${context.length} chars) for ${result.sessionId}`);
        }
      }

      callback({
        success: true,
        acpSessionId: result.sessionId,
        sessionId: result.sessionId,
        configOptions: finalMeta?.configOptions
      });
    } catch (err) {
      writeLog(`[ACP ERR] create_session failed: ${err.message}`);
      callback({ error: err.message });
    }
  });

  // Exports a self-contained session folder: DB snapshot + JSONL (ACP source of truth) + attachments
  socket.on('export_session', async ({ uiId, exportPath }, callback) => {
    try {
      const session = await db.getSession(uiId);
      if (!session) return callback?.({ error: 'Session not found' });

      const exportDir = path.resolve(exportPath, session.name.replace(/[<>:"/\\|?*]/g, '_'));
      fs.mkdirSync(exportDir, { recursive: true });

      // Export session JSON (messages, metadata)
      fs.writeFileSync(path.join(exportDir, 'session.json'), JSON.stringify(session, null, 2), 'utf8');

      // Copy JSONL if it exists
      const providerModule = await getProviderModule();
      const { jsonl: jsonlPath } = providerModule.getSessionPaths(session.acpSessionId);
      if (jsonlPath && fs.existsSync(jsonlPath)) fs.copyFileSync(jsonlPath, path.join(exportDir, `${session.acpSessionId}.jsonl`));

      // Copy attachments if they exist
      const attachDir = path.join(getAttachmentsRoot(), uiId);
      if (fs.existsSync(attachDir)) {
        const destAttach = path.join(exportDir, 'attachments');
        fs.mkdirSync(destAttach, { recursive: true });
        for (const file of fs.readdirSync(attachDir)) {
          fs.copyFileSync(path.join(attachDir, file), path.join(destAttach, file));
        }
      }

      writeLog(`[EXPORT] Session ${uiId} exported to ${exportDir}`);
      callback?.({ success: true, exportDir });
    } catch (err) {
      writeLog(`[EXPORT ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  // Merge a forked chat back into its parent:
  // 1. Prompt the fork to summarize its work
  // 2. Send that summary as a message to the parent
  // 3. Delete the fork
  socket.on('merge_fork', async ({ uiId }, callback) => {
    try {
      const forkSession = await db.getSession(uiId);
      if (!forkSession?.forkedFrom || !forkSession.acpSessionId) {
        callback?.({ error: 'Not a valid fork session' });
        return;
      }

      const parentSession = await db.getSession(forkSession.forkedFrom);
      if (!parentSession?.acpSessionId) {
        callback?.({ error: 'Parent session not found' });
        return;
      }

      writeLog(`[MERGE] Merging fork ${uiId} into parent ${forkSession.forkedFrom}`);

      // Step 1: Capture fork summary silently — statsCaptures collects the response
      // text without emitting tokens to the UI, so the user doesn't see streaming
      acpClient.statsCaptures.set(forkSession.acpSessionId, { buffer: '' });
      const summaryPrompt = 'Create a highly detailed summary of everything you have done since the most recent fork, so you can inform the parent chat of your work.';
      await acpClient.sendRequest('session/prompt', {
        sessionId: forkSession.acpSessionId,
        prompt: [{ type: 'text', text: summaryPrompt }]
      });

      const summary = acpClient.statsCaptures.get(forkSession.acpSessionId)?.buffer?.trim() || '(No summary generated)';
      acpClient.statsCaptures.delete(forkSession.acpSessionId);
      writeLog(`[MERGE] Got summary (${summary.length} chars)`);

      // Step 2: Delete the fork
      const providerModule = await getProviderModule();
      providerModule.deleteSessionFiles(forkSession.acpSessionId);
      await db.deleteSession(uiId);
      writeLog(`[MERGE] Fork ${uiId} deleted`);

      // Step 3: Callback fires BEFORE the parent prompt so the frontend switches
      // to the parent session first — otherwise it would miss the incoming tokens
      callback?.({ success: true, parentUiId: forkSession.forkedFrom });

      // Step 4: 1s delay gives the frontend time to switch sessions and join the
      // parent's socket room — without this, tokens would arrive before it's watching
      setTimeout(async () => {
        try {
          const mergeMessage = `A forked child agent is informing you of their work:\n\n${summary}`;
          // Inject user message into parent chat so the frontend shows it
          io.to(`session:${parentSession.acpSessionId}`).emit('merge_message', {
            sessionId: parentSession.acpSessionId,
            text: mergeMessage,
          });
          await acpClient.sendRequest('session/prompt', {
            sessionId: parentSession.acpSessionId,
            prompt: [{ type: 'text', text: mergeMessage }]
          });
          // Manual token_done — promptHandlers normally emits this on turn_end,
          // but we're calling sendRequest directly so we must signal completion ourselves
          io.to(`session:${parentSession.acpSessionId}`).emit('token_done', { sessionId: parentSession.acpSessionId });
          writeLog(`[MERGE] Summary sent to parent ${parentSession.acpSessionId}`);
        } catch (err) {
          writeLog(`[MERGE ERR] Failed to send to parent: ${err.message}`);
        }
      }, 1000);
    } catch (err) {
      writeLog(`[MERGE ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('set_session_option', async ({ uiId, optionId, value }) => {
    const sessions = await db.getAllSessions();
    const session = sessions.find(s => s.id === uiId);
    if (!session || !session.acpSessionId) return;

    try {
      const providerModule = await getProviderModule();
      if (typeof providerModule.setConfigOption === 'function') {
        await providerModule.setConfigOption(acpClient, session.acpSessionId, optionId, value);
      } else {
        await acpClient.setConfigOption(session.acpSessionId, optionId, value);
      }

      const updatedOptions = mergeConfigOptions(session.configOptions, [{ id: optionId, currentValue: value }]);
      const meta = acpClient.sessionMetadata.get(session.acpSessionId);
      if (meta) {
        meta.configOptions = mergeConfigOptions(meta.configOptions, updatedOptions);
      }
      await db.saveConfigOptions(session.acpSessionId, updatedOptions);
    } catch (err) {
      writeLog(`[OPTION ERR] ${err.message}`);
    }
  });

  socket.on('set_session_model', async ({ uiId, model }) => {
    const sessions = await db.getAllSessions();
    const session = sessions.find(s => s.id === uiId);
    if (!session || !session.acpSessionId) return;

    try {
      const { models } = getProvider().config;
      const resolvedModelId = models[model]?.id || models.flagship.id;

      writeLog(`[SESSION] Switching model for ${uiId} (${session.acpSessionId}) to ${model} (${resolvedModelId})`);

      await acpClient.sendRequest('session/set_model', {
        sessionId: session.acpSessionId,
        modelId: resolvedModelId
      });

      // Update metadata and DB
      const meta = acpClient.sessionMetadata.get(session.acpSessionId);
      if (meta) meta.model = resolvedModelId;

      session.model = model;
      await db.saveSession(session);

      writeLog(`[SESSION] Model switch complete for ${uiId}`);
    } catch (err) {
      writeLog(`[SESSION ERR] Failed to switch model: ${err.message}`);
    }
  });
}
