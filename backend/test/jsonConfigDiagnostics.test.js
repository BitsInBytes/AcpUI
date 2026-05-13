import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectInvalidJsonConfigErrors,
  hasStartupBlockingJsonConfigError
} from '../services/jsonConfigDiagnostics.js';

const tempRoots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-json-config-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'configuration'), { recursive: true });
  return root;
}

function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
  return filePath;
}

function writeText(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('jsonConfigDiagnostics', () => {
  it('returns no errors when loaded JSON config files are valid', () => {
    const root = makeRoot();
    writeJson(root, 'configuration/providers.json', {
      defaultProviderId: 'test-provider',
      providers: [{ id: 'test-provider', path: './providers/test-provider' }]
    });
    writeJson(root, 'providers/test-provider/provider.json', { name: 'Test Provider' });
    writeJson(root, 'providers/test-provider/user.json', { paths: { sessions: '/tmp/sessions' } });
    writeJson(root, 'configuration/mcp.json', { tools: {} });

    const errors = collectInvalidJsonConfigErrors({}, root);

    expect(errors).toEqual([]);
    expect(hasStartupBlockingJsonConfigError(errors)).toBe(false);
  });

  it('lists every malformed config file it can discover', () => {
    const root = makeRoot();
    const registryPath = writeJson(root, 'configuration/providers.json', {
      defaultProviderId: 'test-provider',
      providers: [{ id: 'test-provider', label: 'Test Provider', path: './providers/test-provider' }]
    });
    const providerPath = writeText(root, 'providers/test-provider/provider.json', '{ invalid provider');
    const brandingPath = writeText(root, 'providers/test-provider/branding.json', '{ invalid branding');
    const workspacePath = writeText(root, 'config/workspaces.json', '{ invalid workspace');
    const commandsPath = writeText(root, 'config/commands.json', '{ invalid commands');
    const mcpPath = writeText(root, 'config/mcp.json', '{ invalid mcp');

    const errors = collectInvalidJsonConfigErrors({
      WORKSPACES_CONFIG: './config/workspaces.json',
      COMMANDS_CONFIG: './config/commands.json',
      MCP_CONFIG: './config/mcp.json'
    }, root);

    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Test Provider provider definition', path: providerPath, blocksStartup: true }),
      expect.objectContaining({ label: 'Test Provider provider branding', path: brandingPath }),
      expect.objectContaining({ label: 'Workspace configuration', path: workspacePath }),
      expect.objectContaining({ label: 'Custom commands configuration', path: commandsPath }),
      expect.objectContaining({ label: 'MCP configuration', path: mcpPath })
    ]));
    expect(errors).not.toContainEqual(expect.objectContaining({ path: registryPath, label: 'Provider registry' }));
    expect(hasStartupBlockingJsonConfigError(errors)).toBe(true);
  });

  it('reports missing enabled provider definitions as startup-blocking', () => {
    const root = makeRoot();
    const providerPath = path.join(root, 'providers/missing-provider/provider.json');
    writeJson(root, 'configuration/providers.json', {
      defaultProviderId: 'missing-provider',
      providers: [{ id: 'missing-provider', label: 'Missing Provider', path: './providers/missing-provider' }]
    });

    const errors = collectInvalidJsonConfigErrors({}, root);

    expect(errors).toContainEqual(expect.objectContaining({
      label: 'Missing Provider provider definition',
      path: providerPath,
      message: 'File does not exist',
      blocksStartup: true
    }));
    expect(hasStartupBlockingJsonConfigError(errors)).toBe(true);
  });

  it('reports a malformed provider registry and skips provider directory discovery', () => {
    const root = makeRoot();
    const registryPath = writeText(root, 'configuration/providers.json', '{ invalid registry');
    const commandsPath = writeText(root, 'commands.json', '{ invalid commands');

    const errors = collectInvalidJsonConfigErrors({}, root);

    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Provider registry', path: registryPath, blocksStartup: true }),
      expect.objectContaining({ label: 'Custom commands configuration', path: commandsPath })
    ]));
    expect(errors.some(error => error.label.includes('provider definition'))).toBe(false);
    expect(hasStartupBlockingJsonConfigError(errors)).toBe(true);
  });
});
