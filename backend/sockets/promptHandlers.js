import fs from 'fs';
import sharp from 'sharp';
import { writeLog } from '../services/logger.js';
import acpClient from '../services/acpClient.js';
import { autoSaveTurn } from '../services/sessionManager.js';
import { getProvider } from '../services/providerLoader.js';
import { resolveModelSelection } from '../services/modelOptions.js';

import { getAllRunning, removeSubAgentsForParent } from '../mcp/subAgentRegistry.js';
import { cleanupAcpSession } from '../mcp/acpCleanup.js';

export default function registerPromptHandlers(io, socket) {
  socket.on('prompt', async ({ uiId: _uiId, sessionId, prompt, model, attachments = [] }) => {
    writeLog(`UI Prompt [${sessionId}] (Model: ${model}): ${typeof prompt === 'string' ? prompt : '(Complex)'}`);
    try {
      const { models: providerModels } = getProvider().config;
      let meta = acpClient.sessionMetadata.get(sessionId);
      const modelId = resolveModelSelection(model, providerModels, meta?.modelOptions).modelId;
      
      if (!meta) {
        // Session not loaded in this process — tell UI to re-hydrate
        io.to('session:' + sessionId).emit('token', { sessionId, text: '\n\n:::ERROR:::\nSession expired. Please refresh the page to reconnect.\n:::END_ERROR:::\n\n' });
        io.to('session:' + sessionId).emit('token_done', { sessionId, error: true });
        return;
      }

      if (meta.model !== modelId) {
        writeLog(`[ACP] Switching session ${sessionId} to model: ${modelId}`);
        await acpClient.sendRequest('session/set_model', {
          sessionId: sessionId,
          modelId: modelId
        });
        meta.model = modelId;
        await new Promise(r => setTimeout(r, 200));
      }

      meta.promptCount = (meta.promptCount || 0) + 1;
      if (meta.promptCount === 1 && typeof prompt === 'string') {
        meta.userPrompt = prompt;
      }

      // Background Title Generation — triggered on first agent_message_chunk in acpClient.js

      const acpPromptParts = [];

      if (attachments && attachments.length > 0) {
        for (const file of attachments) {
          const isImage = (file.mimeType || '').startsWith('image/');
          if (isImage) {
            const data = file.data || (file.path ? fs.readFileSync(file.path).toString('base64') : null);
            if (data) {
              try {
                const buf = Buffer.from(data, 'base64');
                const maxDim = getProvider().config.branding?.maxImageDimension || 1568;
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
        // REMOVED: meta.promptCount++; (Duplicate increment fixed)
      }

      const response = await acpClient.sendRequest('session/prompt', {
        sessionId: sessionId,
        prompt: acpPromptParts
      });

      if (response && response.usage) {
         if (meta) {
            meta.usedTokens = response.usage.totalTokens || meta.usedTokens;
         }
         io.to('session:' + sessionId).emit('stats_push', { sessionId, usedTokens: meta?.usedTokens, totalTokens: meta?.totalTokens });
      }

      // If statsCaptures still has this session, a tool_result is pending — don't finalize yet.
      // Otherwise the turn is complete: notify UI and persist to JSONL/DB.
      if (!acpClient.statsCaptures.has(sessionId)) {
        io.to('session:' + sessionId).emit('token_done', { sessionId });
        autoSaveTurn(sessionId, acpClient);
        writeLog(`[HOOKS] Turn complete for ${sessionId}, agentName=${meta?.agentName}`);
      }
    } catch (err) {
      const errorMessage = err.message || 'An unknown error occurred.';
      writeLog(`Prompt Error: ${JSON.stringify(err)}`);
      
      if (acpClient.statsCaptures.has(sessionId)) {
        acpClient.statsCaptures.delete(sessionId);
      } else {
        io.to('session:' + sessionId).emit('token', { 
          sessionId, 
          text: `\n\n:::ERROR:::\n${errorMessage}\n:::END_ERROR:::\n\n**Recovery:** The request failed. You can try asking again, or check the server logs for more technical details.` 
        });
        io.to('session:' + sessionId).emit('token_done', { sessionId, error: true });
        
        // ENSURE PERSISTENCE ON FAILURE: 
        // This prevents the 'Thinking...' bubble on refresh.
        autoSaveTurn(sessionId, acpClient);
      }
    }

  });

  // Cancel flow: (1) cancel parent ACP session, (2) abort the invoke_sub_agents MCP tool
  // (rejects its pending promises), (3) cancel each sub-agent's ACP session individually,
  // (4) reject any pending JSON-RPC requests for those sessions, (5) cleanup disk files
  socket.on('cancel_prompt', ({ sessionId }) => {
    writeLog(`Canceling prompt for session: ${sessionId}`);
    acpClient.sendNotification('session/cancel', { sessionId });

    // Abort any running sub-agent MCP tool
    if (acpClient._abortSubAgents) {
      acpClient._abortSubAgents();
      acpClient._abortSubAgents = null;
    }

    // Also cancel any running sub-agents
    for (const sub of getAllRunning()) {
      writeLog(`[SUB-AGENT] Canceling sub-agent ${sub.acpId}`);
      acpClient.sendNotification('session/cancel', { sessionId: sub.acpId });
      // Reject any pending requests for this sub-agent session
      for (const [id, pending] of acpClient.pendingRequests) {
        if (pending.params?.sessionId === sub.acpId) {
          pending.reject(new Error('Session cancelled'));
          acpClient.pendingRequests.delete(id);
        }
      }
      io.emit('sub_agent_completed', { acpSessionId: sub.acpId, index: sub.index, error: 'Cancelled' });
      cleanupAcpSession(sub.acpId);
      acpClient.sessionMetadata.delete(sub.acpId);
    }
    removeSubAgentsForParent(null); // clear all
  });

  // ACP pauses execution on permission_request; this forwards the user's allow/deny
  // back to ACP via the stored request ID so the tool call can proceed or abort
  socket.on('respond_permission', ({ id, optionId, toolCallId: _toolCallId, sessionId: _sessionId }) => {
    writeLog(`Responding to permission request ${id} with option: ${optionId}`);
    acpClient.respondToPermission(id, optionId);
  });

  socket.on('set_mode', async ({ sessionId, modeId }) => {
    writeLog(`Setting mode for session ${sessionId} to: ${modeId}`);
    try {
      await acpClient.setMode(sessionId, modeId);
    } catch (err) {
      writeLog(`Error setting mode: ${err.message}`);
    }
  });
}
