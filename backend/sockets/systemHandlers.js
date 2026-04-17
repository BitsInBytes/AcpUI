import fs from 'fs';
import acpClient from '../services/acpClient.js';
import { getLogFilePath } from '../services/logger.js';

export default function registerSystemHandlers(io, socket) {
  socket.on('get_stats', async ({ sessionId }, callback) => {
    const meta = acpClient.sessionMetadata.get(sessionId) || {
      model: 'Unknown', toolCalls: 0, successTools: 0, startTime: Date.now(), usedTokens: 0, totalTokens: 0
    };
    if (meta.totalTokens === 0) {
      meta.totalTokens = 1000000;
    }

    const durationMs = Date.now() - meta.startTime;
    const estimatedSizeBytes = meta.usedTokens * 4;
    const sessionSizeMb = (estimatedSizeBytes / (1024 * 1024)).toFixed(2);

    const structuredStats = {
      sessionId, sessionPath: 'Relative', model: meta.model,
      toolCalls: meta.toolCalls, successTools: meta.successTools,
      durationMs, usedTokens: meta.usedTokens, totalTokens: meta.totalTokens,
      sessionSizeMb: parseFloat(sessionSizeMb), quotas: []
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
