import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const requiredCallableExports = [
  'intercept',
  'normalizeUpdate',
  'normalizeModelState',
  'normalizeConfigOptions',
  'extractToolOutput',
  'extractFilePath',
  'extractDiffFromToolCall',
  'extractToolInvocation',
  'normalizeTool',
  'categorizeToolCall',
  'parseExtension',
  'emitCachedContext',
  'prepareAcpEnvironment',
  'performHandshake',
  'setInitialAgent',
  'setConfigOption',
  'buildSessionParams',
  'getSessionPaths',
  'cloneSession',
  'archiveSessionFiles',
  'restoreSessionFiles',
  'deleteSessionFiles',
  'parseSessionHistory',
  'getSessionDir',
  'getAttachmentsDir',
  'getAgentsDir',
  'getHooksForAgent',
  'getMcpServerMeta',
  'onPromptStarted',
  'onPromptCompleted'
];

describe('provider contract exports', () => {
  it('every provider module exports callable contract hooks', async () => {
    const providersRoot = path.resolve(process.cwd(), '..', 'providers');
    const providers = fs.readdirSync(providersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(providers.length).toBeGreaterThan(0);

    let checkedCount = 0;
    for (const providerId of providers) {
      const indexPath = path.join(providersRoot, providerId, 'index.js');
      if (!fs.existsSync(indexPath)) continue;

      checkedCount += 1;
      const moduleExports = await import(pathToFileURL(indexPath).href);

      for (const exportName of requiredCallableExports) {
        expect(
          moduleExports[exportName],
          `${providerId} must export callable ${exportName}`
        ).toEqual(expect.any(Function));
      }
    }

    expect(checkedCount).toBeGreaterThan(0);
  });
});
