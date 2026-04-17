import { writeLog } from './logger.js';
import * as db from '../database.js';

export function findSessionFiles(_sessionId) {
  // Stub — session file discovery not implemented
  return [];
}

export async function autoSaveTurn(sessionId, acpClient = null) {
  try {
    // Wait for any final tool call/token updates from the AI process to settle
    await new Promise(r => setTimeout(r, 5000));

    // Don't force-complete if a permission request is pending
    if (acpClient?.pendingPermissions?.has(sessionId)) {
      writeLog(`[DB] Skipping auto-save for ${sessionId} — permission request pending`);
      return;
    }

    const session = await db.getSessionByAcpId(sessionId);
    const meta = acpClient?.sessionMetadata?.get(sessionId);
    
    if (session && session.messages && session.messages.length > 0) {
      const lastMsg = session.messages[session.messages.length - 1];
      
      // Update configOptions from memory if available
      if (meta?.configOptions) {
        session.configOptions = meta.configOptions;
      }
      
      // Only save if it's still in a streaming state in the DB
      if (lastMsg.role === 'assistant' && lastMsg.isStreaming) {
        writeLog(`[DB] Auto-completing turn for disconnected UI: ${sessionId}`);
        lastMsg.isStreaming = false;
        
        // If the message is completely empty, it means the UI never sent ANY updates. 
        // We don't want to save an empty bubble as 'finished' because that's non-recoverable.
        if (lastMsg.content || (lastMsg.timeline && lastMsg.timeline.length > 0)) {
          await db.saveSession(session);
        }
      }
    }
  } catch (e) {
    writeLog(`[DB ERR] Auto-save failed: ${e.message}`);
  }
}
