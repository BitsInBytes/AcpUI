import { writeLog } from './logger.js';
import { autoSaveTurn } from './sessionManager.js';
import { runHooks } from './hookRunner.js';
import { getProvider, getProviderModule } from './providerLoader.js';
import { applyConfigOptionsChange, normalizeConfigOptions, normalizeRemovedConfigOptionIds } from './configOptions.js';
import * as db from '../database.js';
import * as Diff from 'diff';
import fs from 'fs';
import path from 'path';

/**
 * Routes ACP session/update events to the UI via socket.io.
 * Handles two bypass paths: draining sessions (swallow all chunks) and
 * statsCaptures (buffer text silently for internal use like title generation).
 */
export async function handleUpdate(acpClient, sessionId, update) {
  if (!update) return;
  const { config } = getProvider();
  const providerModule = await getProviderModule();

  // 1. Normalize the update object
  // If the provider module exists, we delegate normalization to it. This handles
  // non-standard data formats before they reach the generic logic.
  update = providerModule.normalizeUpdate(update);

  if (update.sessionUpdate === 'config_option_update') {
    const incomingOptions = normalizeConfigOptions(update.configOptions);
    const replace = update.replace === true || update.mode === 'replace';
    const removeOptionIds = normalizeRemovedConfigOptionIds(update.removeOptionIds);

    if (incomingOptions.length === 0 && removeOptionIds.length === 0 && !replace) {
      writeLog(`[ACP] Ignoring empty config_option_update for ${sessionId}`);
      return;
    }

    const meta = acpClient.sessionMetadata.get(sessionId);
    const hasMetadata = Boolean(meta);
    const mergedOptions = applyConfigOptionsChange(meta?.configOptions, incomingOptions, { replace, removeOptionIds });
    if (meta) {
      meta.configOptions = mergedOptions;
    }

    if (config.protocolPrefix) {
      acpClient.io.emit('provider_extension', {
        method: `${config.protocolPrefix}config_options`,
        params: {
          sessionId,
          options: hasMetadata ? mergedOptions : incomingOptions,
          replace: hasMetadata || replace,
          removeOptionIds
        }
      });
    }

    if (typeof db.saveConfigOptions === 'function') {
      db.saveConfigOptions(sessionId, incomingOptions, { replace, removeOptionIds }).catch(err =>
        writeLog(`[DB ERR] Failed to save configOptions for ${sessionId}: ${err.message}`)
      );
    }
    return;
  }

  // Check if we are currently draining history for this session.
  // Draining happens during session/load to swallow the historical NDJSON dump
  // so it doesn't flood the UI with "replayed" messages.
  const drainState = acpClient.drainingSessions.get(sessionId);
  if (drainState) {
    drainState.chunkCount++;
    // Reset the silence timer because we received a chunk
    if (drainState.resetTimer) drainState.resetTimer();
    return; // Drop the chunk
  }

  if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
    if (!acpClient._lastPeriodicSave) acpClient._lastPeriodicSave = new Map();
    const now = Date.now();
    const last = acpClient._lastPeriodicSave.get(sessionId) || 0;
    if (now - last > 3000) {
      acpClient._lastPeriodicSave.set(sessionId, now);
      autoSaveTurn(sessionId, acpClient);
    }
  }

  const resolvePath = (p) => {
    if (!p || p.includes('...')) return undefined;
    try {
      const abs = path.resolve(p);
      return fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    } catch { return p; }
  };

  const getFilePathFromUpdate = (u) => {
    // 1. Prioritize provider-specific extraction (handles custom schemas/relative paths)
    return providerModule.extractFilePath(u, resolvePath);
  };

  if (update.sessionUpdate === 'agent_message_chunk') {
    const meta = acpClient.sessionMetadata.get(sessionId);
    let text = update.content?.text || '';

    if (text) {
      // Strip out common noise that appears in streams from certain models/clis
      text = text.replace(/\[Thought: true\]/g, '');
      
      if (meta) {
        meta.usedTokens += text.length / 4; // Rough token estimate
        if (meta.lastResponseBuffer !== undefined) meta.lastResponseBuffer += text;
      }
      if (acpClient.statsCaptures.has(sessionId)) {
        // statsCaptures: buffer output silently — this session is internal (e.g., title gen)
        acpClient.statsCaptures.get(sessionId).buffer += text;
      } else {
        acpClient.io.to('session:' + sessionId).emit('token', { sessionId, text });

        // Title generation fires on first response chunk (not prompt submission)
        // so we know the model is actually responding — avoids titling failed/empty sessions.
        if (meta && meta.promptCount === 1 && !meta.titleGenerated && !meta.isSubAgent) {
          meta.titleGenerated = true;
          acpClient.generateTitle(sessionId, meta).catch(err => writeLog(`[TITLE ERR] ${err.message}`));
        }
      }
    }
  } 
  else if (update.sessionUpdate === 'agent_thought_chunk') {
    const meta = acpClient.sessionMetadata.get(sessionId);
    let text = update.content?.text || '';
    if (text) {
      text = text.replace(/\[Thought: true\]/g, '');
      
      if (meta) {
        meta.usedTokens += text.length / 4;
        if (meta.lastThoughtBuffer !== undefined) meta.lastThoughtBuffer += text;
        // Clear response buffer — thought interrupts mean previous response text was speculative
        if (meta.lastResponseBuffer !== undefined) meta.lastResponseBuffer = '';
      }
      if (!acpClient.statsCaptures.has(sessionId)) {
        acpClient.io.to('session:' + sessionId).emit('thought', { sessionId, text });
      }
    }
  }
  else if (update.sessionUpdate === 'tool_call') {
    const meta = acpClient.sessionMetadata.get(sessionId);
    if (meta) {
      meta.toolCalls++;
      // Clear response buffer — tool call means model is acting, not speaking
      if (meta.lastResponseBuffer !== undefined) meta.lastResponseBuffer = '';
    }
    if (acpClient.statsCaptures.has(sessionId)) return;

    const titleStr = update.title || 'Running tool';
    const filePath = getFilePathFromUpdate(update);

    // Extract diff/content from tool_call (certain providers send diffs here for validation)
    const toolOutput = providerModule.extractDiffFromToolCall(update, Diff);

    let eventToEmit = { sessionId, type: 'tool_start', id: update.toolCallId, title: titleStr, filePath, output: toolOutput };

    // Step 1: Normalize format (provider-specific structure → standard fields)
    eventToEmit = providerModule.normalizeTool(eventToEmit, update);

    // Step 2: Categorize (provider maps its own tools to a category — UI tools are the frontend's concern)
    const category = providerModule.categorizeToolCall(eventToEmit);
    if (category) eventToEmit = { ...eventToEmit, ...category };

    acpClient.io.to('session:' + sessionId).emit('system_event', eventToEmit);

    // Track parent session for tools that spawn sub-agents for room inheritance
    if (titleStr.includes('invoke_sub_agents') || titleStr.includes('counsel')) {
      acpClient.lastSubAgentParentAcpId = sessionId;
    }
  }
  else if (update.sessionUpdate === 'tool_call_update') {
    // Ignore intermediate updates that are completely empty
    if (!update.status && (!update.content || update.content.length === 0) && (!update.rawOutput || update.rawOutput.length === 0) && !update.rawInput && !update.arguments && !update.locations && !update.title) {
      return;
    }

    const meta = acpClient.sessionMetadata.get(sessionId);
    if (update.status === 'completed') {
      if (meta) {
        meta.successTools++;
        // Run postToolUse hooks (async, don't block)
        if (meta.agentName && update.rawInput) {
          runHooks(meta.agentName, 'post_tool', update.rawInput, { matcher: update.title || '', io: acpClient.io, sessionId });
        }
      }
    }
    if (acpClient.statsCaptures.has(sessionId)) return;

    let filePath = getFilePathFromUpdate(update);
    // Prefer provider's output extractor (handles non-standard formats)
    let toolOutput = providerModule.extractToolOutput(update);

    // Standard ACP fallback: content[] array
    if (toolOutput === undefined && update.content && Array.isArray(update.content) && update.content.length > 0) {
      const contentItem = update.content[0];
      if (contentItem.type === 'content' && contentItem.content?.type === 'text') {
        toolOutput = contentItem.content.text;
      } else if (contentItem.type === 'diff') {
        // Generate a unified diff for file changes
        toolOutput = Diff.createPatch(update.toolCallId || 'file', contentItem.oldText || '', contentItem.newText || '', 'old', 'new');
      }
    }

    if (toolOutput) {
      if (meta) meta.usedTokens += toolOutput.length / 4;
    }

    let titleToUse = update.title;
    if (meta) {
      const toolId = update.toolCallId;
      if (!meta.toolData) meta.toolData = new Map();
      if (!meta.toolData.has(toolId)) meta.toolData.set(toolId, {});
      const tData = meta.toolData.get(toolId);
      if (filePath) tData.filePath = filePath;
      if (update.title) tData.title = update.title;
      
      // Re-inject if this chunk is generic
      if (!filePath && tData.filePath) filePath = tData.filePath;
      if (!titleToUse && tData.title) titleToUse = tData.title;
    }

    let endEvent = { 
      sessionId, 
      type: update.status ? 'tool_end' : 'tool_update', 
      id: update.toolCallId, 
      status: update.status, 
      output: toolOutput, 
      filePath,
      title: titleToUse
    };
    
    // Normalize and categorize again so the UI receives the same metadata
    endEvent = providerModule.normalizeTool(endEvent, update);
    const category = providerModule.categorizeToolCall(endEvent);
    if (category) endEvent = { ...endEvent, ...category };

    // Final safety: if normalization resulted in a generic title but we have a cached better one, use it
    if (meta && endEvent.title && !endEvent.title.includes(':')) {
       const cachedTitle = meta.toolData?.get(update.toolCallId)?.title;
       if (cachedTitle && cachedTitle.length > endEvent.title.length) {
          // Re-normalize with the better title
          endEvent = providerModule.normalizeTool({ ...endEvent, title: cachedTitle }, update);
       }
    }

    acpClient.io.to('session:' + sessionId).emit('system_event', endEvent);
  }
  else if (update.sessionUpdate === 'usage_update') {
    const meta = acpClient.sessionMetadata.get(sessionId);
    if (meta && update.used !== undefined && update.size !== undefined) {
       meta.usedTokens = update.used;
       meta.totalTokens = update.size;
       acpClient.io.to('session:' + sessionId).emit('stats_push', { sessionId, usedTokens: meta.usedTokens, totalTokens: meta.totalTokens });
       if (config.protocolPrefix && update.size > 0) {
         acpClient.io.emit('provider_extension', {
           method: `${config.protocolPrefix}metadata`,
           params: { sessionId, contextUsagePercentage: (update.used / update.size) * 100 }
         });
       }
    }
  }
  else if (update.sessionUpdate === 'available_commands_update') {
    // Some providers send command updates here
    if (config.protocolPrefix) {
      acpClient.io.emit('provider_extension', {
        method: `${config.protocolPrefix}commands/available`,
        params: { sessionId, commands: update.availableCommands }
      });
    }
  }
}
