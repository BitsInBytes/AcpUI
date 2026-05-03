import fs from 'fs';
import * as Diff from 'diff';
import { writeLog } from './logger.js';
import { getProviderModule } from './providerLoader.js';

/**
 * Parse a JSONL session file and reconstruct UI messages.
 * Returns null if file doesn't exist or can't be parsed.
 */
export async function parseJsonlSession(acpSessionId, providerId = null) {
  const providerModule = await getProviderModule(providerId);
  const paths = providerModule.getSessionPaths(acpSessionId);
  const filePath = paths.jsonl;

  if (!fs.existsSync(filePath)) return null;

  try {
    return await providerModule.parseSessionHistory(filePath, Diff);
  } catch (err) {
    writeLog(`[JSONL ERR] Provider failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}
