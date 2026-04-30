import { getProviderModule } from '../services/providerLoader.js';
import { writeLog } from '../services/logger.js';

/**
 * Delete ACP session files from disk (.jsonl, .json, tasks folder).
 * Used for ephemeral sessions (title generation, sub-agents) and chat deletion.
 *
 * @param {string} acpSessionId - The ACP session ID to clean up
 * @param {string} providerId - The provider ID
 * @param {string} context - Optional context label (e.g., 'title-generation', 'sub-agent', 'user-delete')
 */
export async function cleanupAcpSession(acpSessionId, providerId = null, context = 'unknown') {
  if (!acpSessionId) return;
  const providerModule = await getProviderModule(providerId);

  providerModule.deleteSessionFiles(acpSessionId);
  writeLog(`[CLEANUP] Removed ACP session files for ${acpSessionId} (${context})`);
}
