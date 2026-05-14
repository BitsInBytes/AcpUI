import { writeLog } from './logger.js';
import * as db from '../database.js';
import { getProvider } from './providerLoader.js';
import { cleanupAcpSession } from '../mcp/acpCleanup.js';
import { modelOptionsFromProviderConfig } from './modelOptions.js';

const MAX_PROMPT_CONTEXT_CHARS = 400;

function getConfiguredModelId(providerId, kind) {
  const models = getProvider(providerId).config.models || {};
  return models[kind] || models.default || modelOptionsFromProviderConfig(models)[0]?.id || '';
}

function promptContentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
    if (part?.content?.type === 'text' && typeof part.content.text === 'string') return part.content.text;
    return '';
  }).filter(Boolean).join('\n').trim();
}

function getMetadataTitlePrompts(meta) {
  const prompts = Array.isArray(meta?.titlePromptHistory) ? meta.titlePromptHistory : [];
  const normalized = prompts.map(promptContentToText).filter(Boolean);

  if (normalized.length > 0) return normalized;
  const firstPrompt = promptContentToText(meta?.userPrompt);
  return firstPrompt ? [firstPrompt] : [];
}

function getRecentUserPrompts(meta, uiSession) {
  const persistedPrompts = Array.isArray(uiSession?.messages)
    ? uiSession.messages
      .filter(message => message?.role === 'user')
      .map(message => promptContentToText(message.content))
      .filter(Boolean)
    : [];
  const metadataPrompts = getMetadataTitlePrompts(meta);
  const prompts = [...persistedPrompts];

  for (const prompt of metadataPrompts) {
    if (prompts[prompts.length - 1] !== prompt) prompts.push(prompt);
  }

  return prompts.slice(-2);
}

function truncatePrompt(prompt) {
  if (prompt.length <= MAX_PROMPT_CONTEXT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_PROMPT_CONTEXT_CHARS).trim()}...`;
}

function buildTitlePrompt(currentTitle, recentPrompts) {
  const safeCurrentTitle = (currentTitle || 'New Chat').replace(/\s+/g, ' ').trim() || 'New Chat';
  const promptLines = recentPrompts.map((prompt, index) => `Prompt ${index + 1}: ${truncatePrompt(prompt)}`);

  return [
    'You update concise chat titles.',
    `Current title: "${safeCurrentTitle}"`,
    '',
    'Recent user prompts, oldest to newest:',
    ...promptLines,
    '',
    'Return only the best chat title, max 6 words, no quotes.',
    'If the current title still accurately describes the work, return the current title exactly.',
    'Only change the title when the recent prompts clearly show the task or focus has changed.',
    'If the current title is generic like "New Chat", replace it with a specific title.'
  ].join('\n');
}

function isValidTitle(title) {
  return title && title.length > 0 && title.length < 100;
}

function cleanupTitleSession(acpClient, titleSessionId, reason) {
  if (!titleSessionId) return;
  acpClient.stream.statsCaptures.delete(titleSessionId);
  acpClient.sessionMetadata.delete(titleSessionId);
  void cleanupAcpSession(titleSessionId, acpClient.providerId, reason)
    .catch(err => writeLog(`[TITLE ERR] Cleanup ${reason}: ${err.message}`));
}

/**
 * Generates a title using a throwaway ACP session. A separate session is required
 * because the main session's context/model can't be interrupted mid-stream, and
 * title generation uses a cheaper/faster model. The session is cleaned up immediately after.
 */
export async function generateTitle(acpClient, sessionId, meta) {
  const providerId = acpClient.getProviderId?.() || acpClient.providerId;
  if (getMetadataTitlePrompts(meta).length === 0) return;

  let titleSessionId;
  try {
    const uiSession = await db.getSessionByAcpId(providerId, sessionId);
    if (!uiSession) return;

    const alwaysRename = process.env.ALWAYS_RENAME_CHATS === 'true';
    if (!alwaysRename && uiSession.name !== 'New Chat') return;

    const recentPrompts = getRecentUserPrompts(meta, uiSession);
    if (recentPrompts.length === 0) return;

    writeLog(`[TITLE] Generating title for session ${sessionId}`);

    const generationPromptCount = Number(meta?.promptCount || 0);
    const currentTitle = (uiSession.name || 'New Chat').trim() || 'New Chat';
    const titlePrompt = buildTitlePrompt(currentTitle, recentPrompts);
    const cwd = process.env.DEFAULT_WORKSPACE_CWD || process.env.HOME || process.cwd();
    const result = await acpClient.transport.sendRequest('session/new', { cwd, mcpServers: [] });
    titleSessionId = result.sessionId;

    const titleModelId = getConfiguredModelId(providerId, 'titleGeneration');

    // Redirect this session's output to a buffer so title tokens do not leak to the UI.
    acpClient.stream.statsCaptures.set(titleSessionId, { buffer: '' });
    acpClient.sessionMetadata.set(titleSessionId, { model: titleModelId, promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });

    if (titleModelId) {
      await acpClient.transport.sendRequest('session/set_model', { sessionId: titleSessionId, modelId: titleModelId });
    }
    await acpClient.transport.sendRequest('session/prompt', { sessionId: titleSessionId, prompt: [{ type: 'text', text: titlePrompt }] });

    const title = acpClient.stream.statsCaptures.get(titleSessionId)?.buffer?.trim();
    if (alwaysRename && Number(meta?.promptCount || 0) !== generationPromptCount) {
      writeLog(`[TITLE] Skipping stale title for ${sessionId}; prompt count advanced`);
      return;
    }

    if (isValidTitle(title) && title !== currentTitle) {
      await db.updateSessionName(uiSession.id, title);
      writeLog(`[TITLE] Set title for ${uiSession.id}: ${title}`);
      acpClient.io.emit('session_renamed', { providerId, uiId: uiSession.id, newName: title });
    }
  } catch (err) {
    writeLog(`[TITLE ERR] ${err.message}`);
  } finally {
    cleanupTitleSession(acpClient, titleSessionId, 'title-generation');
  }
}

export async function generateForkTitle(acpClient, uiId, messages, forkPoint) {
  const providerId = acpClient.getProviderId?.() || acpClient.providerId;
  let titleSessionId;
  try {
    // Gather last 2 user and last 2 assistant messages up to the fork point.
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
    titleSessionId = result.sessionId;
    const titleModelId = getConfiguredModelId(providerId, 'titleGeneration');

    acpClient.stream.statsCaptures.set(titleSessionId, { buffer: '' });
    acpClient.sessionMetadata.set(titleSessionId, { model: titleModelId, promptCount: 0, lastResponseBuffer: '', lastThoughtBuffer: '' });

    const titlePrompt = `Generate a short chat title (max 6 words, no quotes) for this forked conversation. Here is the recent context:\n\n${context}`;
    if (titleModelId) {
      await acpClient.transport.sendRequest('session/set_model', { sessionId: titleSessionId, modelId: titleModelId });
    }
    await acpClient.transport.sendRequest('session/prompt', { sessionId: titleSessionId, prompt: [{ type: 'text', text: titlePrompt }] });

    const title = acpClient.stream.statsCaptures.get(titleSessionId)?.buffer?.trim();

    if (isValidTitle(title)) {
      await db.updateSessionName(uiId, title);
      writeLog(`[TITLE] Set fork title for ${uiId}: ${title}`);
      acpClient.io.emit('session_renamed', { providerId, uiId, newName: title });
    }
  } catch (err) {
    writeLog(`[TITLE ERR] Fork title: ${err.message}`);
  } finally {
    cleanupTitleSession(acpClient, titleSessionId, 'fork-title-generation');
  }
}
