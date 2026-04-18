import { writeLog } from './logger.js';

export class StreamController {
  constructor() {
    this.statsCaptures = new Map();
    this.drainingSessions = new Map();
  }

  beginDraining(sessionId) {
    writeLog(`[ACP DRAIN] Beginning drain phase for session ${sessionId}`);
    if (this.drainingSessions.has(sessionId)) {
      clearTimeout(this.drainingSessions.get(sessionId).timer);
    }
    this.drainingSessions.set(sessionId, {
      startTime: Date.now(),
      chunkCount: 0
    });
  }

  onChunk(sessionId) {
    const drain = this.drainingSessions.get(sessionId);
    if (drain) {
      drain.chunkCount++;
      drain.lastChunkTime = Date.now();
      if (drain.resolve) {
         if (drain.timer) clearTimeout(drain.timer);
         drain.timer = setTimeout(() => {
            writeLog(`[ACP DRAIN] Drain finished for ${sessionId} after ${drain.chunkCount} chunks`);
            this.drainingSessions.delete(sessionId);
            drain.resolve();
         }, drain.silenceMs);
      }
    }
  }

  waitForDrainToFinish(sessionId, silenceMs = 1500) {
    const drain = this.drainingSessions.get(sessionId);
    if (!drain) return Promise.resolve();
    
    return new Promise((resolve) => {
      drain.resolve = resolve;
      drain.silenceMs = silenceMs;
      if (drain.timer) clearTimeout(drain.timer);
      drain.timer = setTimeout(() => {
        writeLog(`[ACP DRAIN] Drain finished (timeout) for ${sessionId} after ${drain.chunkCount} chunks`);
        this.drainingSessions.delete(sessionId);
        resolve();
      }, silenceMs);
    });
  }

  reset() {
    this.statsCaptures.clear();
    for (const [_id, drain] of this.drainingSessions) {
      if (drain.timer) clearTimeout(drain.timer);
      if (drain.resolve) drain.resolve();
    }
    this.drainingSessions.clear();
  }
}
