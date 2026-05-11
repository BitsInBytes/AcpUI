import fs from 'fs';
import acpClient from '../services/acpClient.js';
import providerRuntimeManager from '../services/providerRuntimeManager.js';
import { getLogFilePath } from '../services/logger.js';
import * as db from '../database.js';

function getClientForProvider(providerId) {
  if (!providerId) return acpClient;

  try {
    return providerRuntimeManager.getClient(providerId);
  } catch {
    const defaultProviderId = acpClient.getProviderId?.() || acpClient.providerId;
    return providerId === defaultProviderId ? acpClient : null;
  }
}

async function resolveSessionContext({ sessionId, providerId, uiId }) {
  let resolvedProviderId = typeof providerId === 'string' && providerId.trim() ? providerId.trim() : null;
  let dbSession = null;

  if (uiId) {
    try {
      dbSession = await db.getSession(uiId);
    } catch {
      // best-effort lookup only
    }
  }

  if (!dbSession && sessionId) {
    try {
      dbSession = resolvedProviderId
        ? await db.getSessionByAcpId(resolvedProviderId, sessionId)
        : await db.getSessionByAcpId(sessionId);
    } catch {
      // best-effort lookup only
    }
  }

  if (!resolvedProviderId && dbSession?.provider) {
    resolvedProviderId = dbSession.provider;
  }

  return { dbSession, resolvedProviderId };
}

export default function registerSystemHandlers(io, socket) {
  socket.on('get_stats', async ({ sessionId, providerId = null, uiId = null }, callback) => {
    const { dbSession: initialDbSession, resolvedProviderId } = await resolveSessionContext({
      sessionId,
      providerId,
      uiId
    });
    let dbSession = initialDbSession;
    const scopedClient = getClientForProvider(resolvedProviderId) || acpClient;
    const existingMeta = scopedClient?.sessionMetadata?.get(sessionId);
    const meta = existingMeta
      ? { ...existingMeta }
      : {
          model: 'Unknown',
          toolCalls: 0,
          successTools: 0,
          startTime: Date.now(),
          usedTokens: 0,
          totalTokens: 0
        };

    const needsPersistedStats = !existingMeta
      || Number(meta.usedTokens || 0) <= 0
      || Number(meta.totalTokens || 0) <= 0;

    if (needsPersistedStats && !dbSession) {
      try {
        dbSession = resolvedProviderId
          ? await db.getSessionByAcpId(resolvedProviderId, sessionId)
          : await db.getSessionByAcpId(sessionId);
      } catch {
        // best-effort DB fallback only
      }
    }

    if (dbSession?.stats) {
      meta.model = dbSession.currentModelId || dbSession.model || meta.model;
      if (Number(meta.usedTokens || 0) <= 0) {
        meta.usedTokens = Number(dbSession.stats.usedTokens || 0);
      }
      if (Number(meta.totalTokens || 0) <= 0) {
        meta.totalTokens = Number(dbSession.stats.totalTokens || 0);
      }
    }

    const finalProviderId = resolvedProviderId || scopedClient?.getProviderId?.() || scopedClient?.providerId || null;
    const usedTokens = Number.isFinite(Number(meta.usedTokens)) ? Number(meta.usedTokens) : 0;
    const totalTokens = Number.isFinite(Number(meta.totalTokens)) ? Number(meta.totalTokens) : 0;
    const durationMs = Math.max(0, Date.now() - Number(meta.startTime || Date.now()));
    const estimatedSizeBytes = usedTokens * 4;
    const sessionSizeMb = (estimatedSizeBytes / (1024 * 1024)).toFixed(2);

    const structuredStats = {
      providerId: finalProviderId,
      sessionId,
      sessionPath: 'Relative',
      model: meta.model,
      toolCalls: Number(meta.toolCalls || 0),
      successTools: Number(meta.successTools || 0),
      durationMs,
      usedTokens,
      totalTokens,
      sessionSizeMb: parseFloat(sessionSizeMb),
      quotas: []
    };

    callback({ stats: structuredStats });
  });

  socket.on('get_logs', () => {
    const logFile = getLogFilePath();
    if (fs.existsSync(logFile)) {
      const logs = fs.readFileSync(logFile, 'utf8');
      socket.emit('log_history', logs);
    }
  });
}
