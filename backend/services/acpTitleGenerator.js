import { writeLog } from './logger.js';
import * as db from '../database.js';
import { getProvider } from './providerLoader.js';
import { cleanupAcpSession } from '../mcp/acpCleanup.js';

/**
 * Generates a title using a throwaway ACP session. A separate session is required
 * because the main session's context/model can't be interrupted mid-stream, and
 * title gen uses a cheaper/faster model. The session is cleaned up immediately after.
 */
export async function generateTitle(acpClient, sessionId, meta) {
  if (!meta.userPrompt) return;
  writeLog(`[TITLE] Generating title for session ${sessionId}`);

  try {
    const cwd = process.env.DEFAULT_WORKSPACE_CWD || process.env.HOME || process.cwd();
    const result = await acpClient.sendRequest('session/new', { cwd, mcpServers: [] });
    const titleSessionId = result.sessionId;

    const titleModelId = getProvider().config.models?.titleGeneration || getProvider().config.models.balanced.id;

    // Redirect this session's output to a buffer — prevents title gen tokens from leaking to UI
    acpClient.statsCaptures.set(titleSessionId, { buffer: '' });
    acpClient.sessionMetadata.set(titleSessionId, { model: titleModelId, promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });

    const titlePrompt = `Generate a short chat title (max 6 words, no quotes) for this user message: "${meta.userPrompt}"`;
    await acpClient.sendRequest('session/set_model', { sessionId: titleSessionId, modelId: titleModelId });
    await acpClient.sendRequest('session/prompt', { sessionId: titleSessionId, prompt: [{ type: 'text', text: titlePrompt }] });

    const title = acpClient.statsCaptures.get(titleSessionId)?.buffer?.trim();
    // Clean up all traces of the ephemeral session — statsCapture, metadata, and ACP-side resources
    acpClient.statsCaptures.delete(titleSessionId);
    acpClient.sessionMetadata.delete(titleSessionId);
    cleanupAcpSession(titleSessionId);

    if (title && title.length > 0 && title.length < 100) {
      const uiSession = await db.getSessionByAcpId(sessionId);
      if (uiSession) {
        const alwaysRename = process.env.ALWAYS_RENAME_CHATS === 'true';
        if (alwaysRename || uiSession.name === 'New Chat') {
          await db.updateSessionName(uiSession.id, title);
          writeLog(`[TITLE] Set title for ${uiSession.id}: ${title}`);
          acpClient.io.emit('session_renamed', { uiId: uiSession.id, newName: title });
        }
      }
    }
  } catch (err) {
    writeLog(`[TITLE ERR] ${err.message}`);
  }
}

export async function generateForkTitle(acpClient, uiId, messages, forkPoint) {
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
    const result = await acpClient.sendRequest('session/new', { cwd, mcpServers: [] });
    const titleSessionId = result.sessionId;
    const titleModelId = getProvider().config.models?.titleGeneration || getProvider().config.models.balanced.id;

    acpClient.statsCaptures.set(titleSessionId, { buffer: '' });
    acpClient.sessionMetadata.set(titleSessionId, { model: titleModelId, promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });

    const titlePrompt = `Generate a short chat title (max 6 words, no quotes) for this forked conversation. Here is the recent context:\n\n${context}`;
    await acpClient.sendRequest('session/set_model', { sessionId: titleSessionId, modelId: titleModelId });
    await acpClient.sendRequest('session/prompt', { sessionId: titleSessionId, prompt: [{ type: 'text', text: titlePrompt }] });

    const title = acpClient.statsCaptures.get(titleSessionId)?.buffer?.trim();
    acpClient.statsCaptures.delete(titleSessionId);
    acpClient.sessionMetadata.delete(titleSessionId);
    cleanupAcpSession(titleSessionId);


    if (title && title.length > 0 && title.length < 100) {
      await db.updateSessionName(uiId, title);
      writeLog(`[TITLE] Set fork title for ${uiId}: ${title}`);
      acpClient.io.emit('session_renamed', { uiId, newName: title });
    }
  } catch (err) {
    writeLog(`[TITLE ERR] Fork title: ${err.message}`);
  }
}
