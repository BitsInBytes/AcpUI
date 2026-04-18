import { getProviderModule } from '../services/providerLoader.js';
import { writeLog } from '../services/logger.js';

/**
 * Delete ACP session files from disk (.jsonl, .json, tasks folder).
 * Used for ephemeral sessions (title generation, sub-agents) and chat deletion.
 */
export async function cleanupAcpSession(acpSessionId, providerId = null) {
  if (!acpSessionId) return;
  const providerModule = await getProviderModule(providerId);
  
  providerModule.deleteSessionFiles(acpSessionId);
  writeLog(`[CLEANUP] Removed ACP session files for ${acpSessionId}`);
}
