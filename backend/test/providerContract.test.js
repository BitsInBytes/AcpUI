import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const requiredExports = [
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
  'getMcpServerMeta'
];

describe('provider contract exports', () => {
  it('every provider explicitly exports every contract function', () => {
    const providersRoot = path.resolve(process.cwd(), '..', 'providers');
    const providers = fs.readdirSync(providersRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);

    expect(providers.length).toBeGreaterThan(0);

    for (const provider of providers) {
      const indexPath = path.join(providersRoot, provider, 'index.js');
      if (!fs.existsSync(indexPath)) continue;

      const source = fs.readFileSync(indexPath, 'utf8');
      for (const exportName of requiredExports) {
        const pattern = new RegExp(`export\\s+(?:async\\s+)?function\\s+${exportName}\\b|export\\s+const\\s+${exportName}\\b`);
        expect(source, `${provider} must explicitly export ${exportName}`).toMatch(pattern);
      }
    }
  });
});
