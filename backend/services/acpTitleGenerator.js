import { writeLog } from './logger.js';
import * as db from '../database.js';
import { getProvider } from './providerLoader.js';
import { cleanupAcpSession } from '../mcp/acpCleanup.js';
import { modelOptionsFromProviderConfig } from './modelOptions.js';

function getConfiguredModelId(providerId, kind) {
  const models = getProvider(providerId).config.models || {};
  return models[kind] || models.default || modelOptionsFromProviderConfig(models)[0]?.id || '';
}

/**
 * Generates a title using a throwaway ACP session. A separate session is required
 * because the main session's context/model can't be interrupted mid-stream, and
 * title gen uses a cheaper/faster model. The session is cleaned up immediately after.
 */
export async function generateTitle(acpClient, sessionId, meta) {
  const providerId = acpClient.getProviderId?.() || acpClient.providerId;
  if (!meta.userPrompt) return;
  writeLog(`[TITLE] Generating title for session ${sessionId}`);

  try {
    const cwd = process.env.DEFAULT_WORKSPACE_CWD || process.env.HOME || process.cwd();
    const result = await acpClient.transport.sendRequest('session/new', { cwd, mcpServers: [] });
    const titleSessionId = result.sessionId;

    const titleModelId = getConfiguredModelId(providerId, 'titleGeneration');

    // Redirect this session's output to a buffer — prevents title gen tokens from leaking to UI
    acpClient.stream.statsCaptures.set(titleSessionId, { buffer: '' });
    acpClient.sessionMetadata.set(titleSessionId, { model: titleModelId, promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });

    const titlePrompt = `Generate a short chat title (max 6 words, no quotes) for this user message: "${meta.userPrompt}"`;
    if (titleModelId) {
      await acpClient.transport.sendRequest('session/set_model', { sessionId: titleSessionId, modelId: titleModelId });
    }
    await acpClient.transport.sendRequest('session/prompt', { sessionId: titleSessionId, prompt: [{ type: 'text', text: titlePrompt }] });

    const title = acpClient.stream.statsCaptures.get(titleSessionId)?.buffer?.trim();
    // Clean up all traces of the ephemeral session — statsCapture, metadata, and ACP-side resources
    acpClient.stream.statsCaptures.delete(titleSessionId);
    acpClient.sessionMetadata.delete(titleSessionId);
    cleanupAcpSession(titleSessionId, acpClient.providerId, 'title-generation');

    if (title && title.length > 0 && title.length < 100) {
      const uiSession = await db.getSessionByAcpId(providerId, sessionId);
      if (uiSession) {
        const alwaysRename = process.env.ALWAYS_RENAME_CHATS === 'true';
        if (alwaysRename || uiSession.name === 'New Chat') {
          await db.updateSessionName(uiSession.id, title);
          writeLog(`[TITLE] Set title for ${uiSession.id}: ${title}`);
          acpClient.io.emit('session_renamed', { providerId, uiId: uiSession.id, newName: title });
        }
      }
    }
  } catch (err) {
    writeLog(`[TITLE ERR] ${err.message}`);
  }
}

export async function generateForkTitle(acpClient, uiId, messages, forkPoint) {
  const providerId = acpClient.getProviderId?.() || acpClient.providerId;
  try {
    // Gather last 2 user and last 2 assistant messages up to the fork point
    const relevant = messages.slice(0, forkPoint + 1);
    const userMsgs = relevant.filter(m => m.role === 'user').slice(-2);
    const assistantMsgs = relevant.filter(m => m.role === 'assistant').slice(-2);

    const context = [
      ...userMsgs.map(m => `User: ${(m.content || '').substring(0, 200)}`),
      ...assistantMsgs.map(m => `Assistant: ${(m.content || '').substring(0, 200)}`),
    ].join('\n');

    if (!context.trim()) return;

    writeLog(`[TITLE] Generating fork title for ${uiId}`);

    const cwd = process.env.DEFAULT_WORKSPACE_CWD || process.env.HOME || process.cwd();
    const result = await acpClient.transport.sendRequest('session/new', { cwd, mcpServers: [] });
    const titleSessionId = result.sessionId;
    const titleModelId = getConfiguredModelId(providerId, 'titleGeneration');

    acpClient.stream.statsCaptures.set(titleSessionId, { buffer: '' });
    acpClient.sessionMetadata.set(titleSessionId, { model: titleModelId, promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });

    const titlePrompt = `Generate a short chat title (max 6 words, no quotes) for this forked conversation. Here is the recent context:\n\n${context}`;
    if (titleModelId) {
      await acpClient.transport.sendRequest('session/set_model', { sessionId: titleSessionId, modelId: titleModelId });
    }
    await acpClient.transport.sendRequest('session/prompt', { sessionId: titleSessionId, prompt: [{ type: 'text', text: titlePrompt }] });

    const title = acpClient.stream.statsCaptures.get(titleSessionId)?.buffer?.trim();
    acpClient.stream.statsCaptures.delete(titleSessionId);
    acpClient.sessionMetadata.delete(titleSessionId);
    cleanupAcpSession(titleSessionId, acpClient.providerId, 'fork-title-generation');


    if (title && title.length > 0 && title.length < 100) {
      await db.updateSessionName(uiId, title);
      writeLog(`[TITLE] Set fork title for ${uiId}: ${title}`);
      acpClient.io.emit('session_renamed', { providerId, uiId, newName: title });
    }
  } catch (err) {
    writeLog(`[TITLE ERR] Fork title: ${err.message}`);
  }
}
