import fs from 'fs';
import sharp from 'sharp';
import { writeLog } from '../services/logger.js';
import { providerRuntimeManager } from '../services/providerRuntimeManager.js';
import { autoSaveTurn } from '../services/sessionManager.js';
import { resolveModelSelection } from '../services/modelOptions.js';

import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';

export default function registerPromptHandlers(io, socket) {
  socket.on('prompt', async ({ providerId, uiId: _uiId, sessionId, prompt, model, attachments = [] }) => {
    let runtime;
    try {
      runtime = providerRuntimeManager.getRuntime(providerId);
    } catch (err) {
      writeLog(`[PROMPT ERR] Invalid provider: ${providerId} - ${err.message}`);
      io.to('session:' + sessionId).emit('token', { providerId, sessionId, text: `\n\n:::ERROR:::\nInvalid provider ID: ${providerId}\n:::END_ERROR:::\n\n` });
      io.to('session:' + sessionId).emit('token_done', { providerId, sessionId, error: true });
      return;
    }
    const acpClient = runtime.client;
    const resolvedProviderId = runtime.providerId;
    
    writeLog(`UI Prompt [${sessionId}] (Model: ${model}): ${typeof prompt === 'string' ? prompt : '(Complex)'}`);
    try {
      const { models: providerModels } = runtime.provider.config;
      let meta = acpClient.sessionMetadata.get(sessionId);
      
      if (!meta) {
        // Session not loaded in this process — tell UI to re-hydrate
        io.to('session:' + sessionId).emit('token', { providerId: resolvedProviderId, sessionId, text: '\n\n:::ERROR:::\nSession expired. Please refresh the page to reconnect.\n:::END_ERROR:::\n\n' });
        io.to('session:' + sessionId).emit('token_done', { providerId: resolvedProviderId, sessionId, error: true });
        return;
      }

      const modelId = resolveModelSelection(model || meta.currentModelId || meta.model, providerModels, meta.modelOptions).modelId;

      if (modelId && meta.model !== modelId) {
        writeLog(`[ACP] Switching session ${sessionId} to model: ${modelId}`);
        await acpClient.transport.sendRequest('session/set_model', {
          sessionId: sessionId,
          modelId: modelId
        });
        meta.model = modelId;
        await new Promise(r => setTimeout(r, 200));
      }

      meta.promptCount = (meta.promptCount || 0) + 1;
      if (typeof prompt === 'string') {
        const promptForTitle = prompt.trim();
        if (promptForTitle) {
          const previousPrompts = Array.isArray(meta.titlePromptHistory)
            ? meta.titlePromptHistory
            : (typeof meta.userPrompt === 'string' && meta.userPrompt.trim() ? [meta.userPrompt] : []);
          meta.titlePromptHistory = [...previousPrompts, promptForTitle].slice(-2);
        }
        if (meta.promptCount === 1) {
          meta.userPrompt = prompt;
        }
      }

      // Background title generation is triggered from response chunks.

      const acpPromptParts = [];

      if (attachments && attachments.length > 0) {
        for (const file of attachments) {
          const isImage = (file.mimeType || '').startsWith('image/');
          if (isImage) {
            const data = file.data || (file.path ? fs.readFileSync(file.path).toString('base64') : null);
            if (data) {
              try {
                const buf = Buffer.from(data, 'base64');
                const maxDim = runtime.provider.config.branding?.maxImageDimension || 1568;
                const compressed = await sharp(buf)
                  .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
                  .jpeg({ quality: 85 })
                  .toBuffer();
                const origKB = Math.round(buf.length / 1024);
                const newKB = Math.round(compressed.length / 1024);
                writeLog(`[IMAGE] Compressed ${origKB}KB → ${newKB}KB`);
                acpPromptParts.push({ type: 'image', mimeType: 'image/jpeg', data: compressed.toString('base64') });
              } catch (err) {
                writeLog(`[IMAGE] Compression failed, sending original: ${err.message}`);
                acpPromptParts.push({ type: 'image', mimeType: file.mimeType, data });
              }
            }
          } else if (file.data) {
            // Drag/drop file — decode base64 and include as text
            const text = Buffer.from(file.data, 'base64').toString('utf8');
            acpPromptParts.push({ type: 'text', text: `--- File: ${file.name} ---\n${text}\n--- End File ---` });
          } else if (file.path) {
            acpPromptParts.push({
              type: 'resource_link',
              uri: `file:///${file.path.replace(/\\/g, '/')}`,
              name: file.name,
              mimeType: file.mimeType
            });
          }
        }
      }

      if (typeof prompt === 'string') {
        acpPromptParts.push({ type: 'text', text: prompt });
      } else if (Array.isArray(prompt)) {
        acpPromptParts.push(...prompt);
      }

      // Inject agentSpawn hook context into first prompt
      if (meta?.spawnContext && meta.promptCount <= 1) {
        acpPromptParts.unshift({ type: 'text', text: meta.spawnContext });
        meta.spawnContext = null;
      }

      if (meta) {
        meta.lastResponseBuffer = '';
        meta.lastThoughtBuffer = '';
      }

      // Notify provider that a real prompt is starting. This is the authoritative
      // signal for lifecycle tracking (e.g. quota polling) — more reliable than
      // watching intercept() which also fires for session/load history drain traffic.
      acpClient.providerModule.onPromptStarted(sessionId);

      try {
        const response = await acpClient.transport.sendRequest('session/prompt', {
          sessionId: sessionId,
          prompt: acpPromptParts
        });

        if (response && response.usage) {
           if (meta) {
              meta.usedTokens = response.usage.totalTokens || meta.usedTokens;
           }
           io.to('session:' + sessionId).emit('stats_push', { providerId: resolvedProviderId, sessionId, usedTokens: meta?.usedTokens, totalTokens: meta?.totalTokens });
        }

        // If statsCaptures still has this session, a tool_result is pending — don't finalize yet.
        // Otherwise the turn is complete: notify UI and persist to JSONL/DB.
        if (!acpClient.stream.statsCaptures.has(sessionId)) {
          io.to('session:' + sessionId).emit('token_done', { providerId: resolvedProviderId, sessionId });
          autoSaveTurn(sessionId, acpClient);
          writeLog(`[HOOKS] Turn complete for ${sessionId}, agentName=${meta?.agentName}`);
        }
      } catch (_err) {
        const errorMessage = _err.message || 'An unknown error occurred.';
        writeLog(`Prompt Error: ${JSON.stringify(_err)}`);

        if (acpClient.stream.statsCaptures.has(sessionId)) {
          acpClient.stream.statsCaptures.delete(sessionId);
        } else {
          io.to('session:' + sessionId).emit('token', {
            providerId: resolvedProviderId,
            sessionId,
            text: `\n\n:::ERROR:::\n${errorMessage}\n:::END_ERROR:::\n\n**Recovery:** The request failed. You can try asking again, or check the server logs for more technical details.`
          });
          io.to('session:' + sessionId).emit('token_done', { providerId: resolvedProviderId, sessionId, error: true });

          // ENSURE PERSISTENCE ON FAILURE:
          // This prevents the 'Thinking...' bubble on refresh.
          autoSaveTurn(sessionId, acpClient);
        }
      } finally {
        // Always notify the provider that this prompt is done — whether it resolved,
        // was cancelled (session/cancel causes sendRequest to resolve with stopReason:
        // "cancelled"), or threw an error. This keeps _activePromptCount accurate.
        acpClient.providerModule.onPromptCompleted(sessionId);
      }
    } catch (_err) {
      // Outer catch: session not found, model switch errors, or attachment processing
      // failures that occur before the prompt is sent. onPromptStarted was never
      // called in this path, so no cleanup is needed.
      writeLog(`Pre-prompt Error: ${JSON.stringify(_err)}`);
      io.to('session:' + sessionId).emit('token', {
        providerId: resolvedProviderId,
        sessionId,
        text: `\n\n:::ERROR:::\n${_err.message || 'An unknown error occurred.'}\n:::END_ERROR:::\n\n**Recovery:** The request failed. You can try asking again, or check the server logs for more technical details.`
      });
      io.to('session:' + sessionId).emit('token_done', { providerId: resolvedProviderId, sessionId, error: true });
    }

  });

  // Cancel flow: (1) cancel parent ACP session, (2) abort the ux_invoke_subagents MCP tool
  // (rejects its pending promises), (3) cancel each sub-agent's ACP session individually,
  // (4) reject any pending JSON-RPC requests for those sessions, (5) cleanup disk files
  socket.on('cancel_prompt', ({ providerId, sessionId }) => {
    let runtime;
    try {
      runtime = providerRuntimeManager.getRuntime(providerId);
    } catch (_err) {
      writeLog(`[CANCEL ERR] Invalid provider: ${providerId}`);
      return;
    }
    const acpClient = runtime.client;
    const resolvedProviderId = runtime.providerId;

    writeLog(`Canceling prompt for session: ${sessionId}`);
    acpClient.transport.sendNotification('session/cancel', { sessionId });

    // Abort ALL in-flight invocations for this provider
    void Promise.resolve(subAgentInvocationManager.cancelAllForParent(sessionId, resolvedProviderId))
      .catch(err => writeLog(`[CANCEL ERR] Failed to cancel sub-agent invocations: ${err.message}`));
  });

  // ACP pauses execution on permission_request; this forwards the user's allow/deny
  // back to ACP via the stored request ID so the tool call can proceed or abort
  socket.on('respond_permission', ({ providerId, id, optionId, toolCallId: _toolCallId, sessionId: _sessionId }) => {
    let runtime;
    try {
      runtime = providerRuntimeManager.getRuntime(providerId);
    } catch (_err) {
      writeLog(`[PERMISSION ERR] Invalid provider: ${providerId}`);
      return;
    }
    writeLog(`Responding to permission request ${id} with option: ${optionId}`);
    runtime.client.permissions.respond(id, optionId, runtime.client.transport);
  });

  socket.on('set_mode', async ({ providerId, sessionId, modeId }) => {
    let runtime;
    try {
      runtime = providerRuntimeManager.getRuntime(providerId);
    } catch (_err) {
      writeLog(`[SET_MODE ERR] Invalid provider: ${providerId}`);
      return;
    }
    writeLog(`Setting mode for session ${sessionId} to: ${modeId}`);
    try {
      await runtime.client.setMode(sessionId, modeId);
    } catch (err) {
      writeLog(`Error setting mode: ${err.message}`);
    }
  });
}
