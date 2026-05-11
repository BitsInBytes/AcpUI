import { writeLog } from './logger.js';
import { autoSaveTurn } from './sessionManager.js';
import { runHooks } from './hookRunner.js';
import { getProvider, getProviderModule } from './providerLoader.js';
import { toolRegistry, toolCallState, resolveToolInvocation, applyInvocationToEvent } from './tools/index.js';
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
  if (typeof acpClient.stream?.onChunk === 'function') {
    acpClient.stream.onChunk(sessionId);
  }
  const providerId = acpClient.getProviderId?.() || acpClient.providerId;
  const { config } = getProvider(providerId);
  const providerModule = await getProviderModule(providerId);

  // 1. Normalize the update object
  // If the provider module exists, we delegate normalization to it. This handles
  // non-standard data formats before they reach the generic logic.
  update = providerModule.normalizeUpdate(update);

  if (update.sessionUpdate === 'config_option_update') {
    const providerOptions = providerModule.normalizeConfigOptions(update.configOptions);
    const incomingOptions = normalizeConfigOptions(providerOptions);
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
        providerId,
        method: `${config.protocolPrefix}config_options`,
        params: {
          providerId,
          sessionId,
          options: hasMetadata ? mergedOptions : incomingOptions,
          replace: hasMetadata || replace,
          removeOptionIds
        }
      });
    }

    if (typeof db.saveConfigOptions === 'function') {
      db.saveConfigOptions(providerId, sessionId, incomingOptions, { replace, removeOptionIds }).catch(err =>
        writeLog(`[DB ERR] Failed to save configOptions for ${sessionId}: ${err.message}`)
      );
    }
    return;
  }

  // Check if we are currently draining history for this session.
  // Draining happens during session/load to swallow the historical NDJSON dump
  // so it doesn't flood the UI with "replayed" messages.
  const drainState = acpClient.stream.drainingSessions.get(sessionId);
  const isMessage = ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate);
  
  if (drainState && isMessage) {
    return; // Drop message chunks during drain
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
      if (acpClient.stream.statsCaptures.has(sessionId)) {
        // statsCaptures: buffer output silently — this session is internal (e.g., title gen)
        acpClient.stream.statsCaptures.get(sessionId).buffer += text;
      } else {
        acpClient.io.to('session:' + sessionId).emit('token', { providerId, sessionId, text });

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
      if (!acpClient.stream.statsCaptures.has(sessionId)) {
        acpClient.io.to('session:' + sessionId).emit('thought', { providerId, sessionId, text });
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
    if (acpClient.stream.statsCaptures.has(sessionId)) return;

    const titleStr = update.title || 'Running tool';
    const filePath = getFilePathFromUpdate(update);

    // Extract diff/content from tool_call (certain providers send diffs here for validation)
    const toolOutput = providerModule.extractDiffFromToolCall(update, Diff);

    let eventToEmit = { providerId, sessionId, type: 'tool_start', id: update.toolCallId, title: titleStr, filePath, output: toolOutput };

    eventToEmit = providerModule.normalizeTool(eventToEmit, update);
    const category = providerModule.categorizeToolCall(eventToEmit);
    if (category) eventToEmit = { ...eventToEmit, ...category };

    const invocation = resolveToolInvocation({ providerId, sessionId, update, event: eventToEmit, providerModule, phase: 'start' });
    eventToEmit = applyInvocationToEvent(eventToEmit, invocation);
    eventToEmit = toolRegistry.dispatch('start', { acpClient, providerId, sessionId }, invocation, eventToEmit);
    toolCallState.upsert({
      providerId,
      sessionId,
      toolCallId: update.toolCallId,
      identity: invocation.identity,
      input: invocation.input,
      display: {
        title: eventToEmit.title,
        titleSource: eventToEmit.title === invocation.display?.title ? invocation.display?.titleSource : 'tool_handler'
      },
      category,
      filePath: eventToEmit.filePath,
      toolSpecific: {
        shellRunId: eventToEmit.shellRunId,
        invocationId: eventToEmit.invocationId
      }
    });

    acpClient.io.to('session:' + sessionId).emit('system_event', eventToEmit);
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
    if (acpClient.stream.statsCaptures.has(sessionId)) return;

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

    let endEvent = { 
      sessionId, 
      providerId,
      type: update.status ? 'tool_end' : 'tool_update', 
      id: update.toolCallId, 
      status: update.status, 
      output: toolOutput, 
      filePath,
      title: update.title
    };
    
    endEvent = providerModule.normalizeTool(endEvent, update);
    const category = providerModule.categorizeToolCall(endEvent);
    if (category) endEvent = { ...endEvent, ...category };

    const phase = update.status ? 'end' : 'update';
    const invocation = resolveToolInvocation({ providerId, sessionId, update, event: endEvent, providerModule, phase });
    endEvent = applyInvocationToEvent(endEvent, invocation);
    endEvent = toolRegistry.dispatch(phase, { acpClient, providerId, sessionId }, invocation, endEvent);
    toolCallState.upsert({
      providerId,
      sessionId,
      toolCallId: update.toolCallId,
      identity: invocation.identity,
      input: invocation.input,
      display: {
        title: endEvent.title,
        titleSource: endEvent.title === invocation.display?.title ? invocation.display?.titleSource : 'tool_handler'
      },
      category,
      filePath: endEvent.filePath,
      toolSpecific: {
        shellRunId: endEvent.shellRunId,
        invocationId: endEvent.invocationId
      }
    });

    acpClient.io.to('session:' + sessionId).emit('system_event', endEvent);
  }
  else if (update.sessionUpdate === 'usage_update') {
    const meta = acpClient.sessionMetadata.get(sessionId);
    if (meta && update.used !== undefined && update.size !== undefined) {
       meta.usedTokens = update.used;
       meta.totalTokens = update.size;
       acpClient.io.to('session:' + sessionId).emit('stats_push', { providerId, sessionId, usedTokens: meta.usedTokens, totalTokens: meta.totalTokens });
       if (config.protocolPrefix) {
         acpClient.io.emit('provider_extension', {
           providerId,
           method: `${config.protocolPrefix}metadata`,
           params: { providerId, sessionId, contextUsagePercentage: update.size > 0 ? (update.used / update.size) * 100 : 100 }
         });
       }

    }
  }
  else if (update.sessionUpdate === 'available_commands_update') {
    // Some providers send command updates here
    if (config.protocolPrefix) {
      acpClient.io.emit('provider_extension', {
        providerId,
        method: `${config.protocolPrefix}commands/available`,
        params: { providerId, sessionId, commands: update.availableCommands }
      });
    }
  }
}
