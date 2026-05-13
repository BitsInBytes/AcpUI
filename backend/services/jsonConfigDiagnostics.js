import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function repoPath(repoRoot, value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function createIssue({ id, label, filePath, error, blocksStartup = false }) {
  return {
    id,
    label,
    path: filePath,
    message: error?.message || 'Invalid JSON',
    blocksStartup
  };
}

function readJsonConfig({ id, label, filePath, required = false, blocksStartup = false }) {
  if (!fs.existsSync(filePath)) {
    if (!required) return { data: null, issue: null };
    return {
      data: null,
      issue: createIssue({
        id,
        label,
        filePath,
        error: new Error('File does not exist'),
        blocksStartup
      })
    };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { data, issue: null };
  } catch (error) {
    return {
      data: null,
      issue: createIssue({ id, label, filePath, error, blocksStartup })
    };
  }
}

function pushIssue(issues, issue) {
  if (!issue) return;
  const key = `${issue.id}:${issue.path}`;
  if (issues.some(existing => `${existing.id}:${existing.path}` === key)) return;
  issues.push(issue);
}

function collectProviderConfigIssues(issues, registryData, repoRoot) {
  const providers = Array.isArray(registryData?.providers) ? registryData.providers : [];

  providers.forEach((entry, index) => {
    if (!entry || entry.enabled === false) return;
    const providerPath = entry.path || entry.providerPath || entry.dir;
    if (!providerPath || typeof providerPath !== 'string') return;

    const basePath = repoPath(repoRoot, providerPath);
    const label = entry.label || entry.name || entry.id || `Provider ${index + 1}`;

    pushIssue(issues, readJsonConfig({
      id: `provider-${entry.id || index}-definition`,
      label: `${label} provider definition`,
      filePath: path.join(basePath, 'provider.json'),
      required: true,
      blocksStartup: true
    }).issue);

    pushIssue(issues, readJsonConfig({
      id: `provider-${entry.id || index}-branding`,
      label: `${label} provider branding`,
      filePath: path.join(basePath, 'branding.json')
    }).issue);

    pushIssue(issues, readJsonConfig({
      id: `provider-${entry.id || index}-user-settings`,
      label: `${label} provider user settings`,
      filePath: path.join(basePath, 'user.json')
    }).issue);
  });
}

export function collectInvalidJsonConfigErrors(env = process.env, repoRoot = REPO_ROOT) {
  const issues = [];

  const registryPath = repoPath(repoRoot, env.ACP_PROVIDERS_CONFIG || 'configuration/providers.json');
  const registryResult = readJsonConfig({
    id: 'provider-registry',
    label: 'Provider registry',
    filePath: registryPath,
    required: true,
    blocksStartup: true
  });
  pushIssue(issues, registryResult.issue);

  pushIssue(issues, readJsonConfig({
    id: 'workspace-config',
    label: 'Workspace configuration',
    filePath: repoPath(repoRoot, env.WORKSPACES_CONFIG || 'workspaces.json')
  }).issue);

  pushIssue(issues, readJsonConfig({
    id: 'commands-config',
    label: 'Custom commands configuration',
    filePath: repoPath(repoRoot, env.COMMANDS_CONFIG || 'commands.json')
  }).issue);

  pushIssue(issues, readJsonConfig({
    id: 'mcp-config',
    label: 'MCP configuration',
    filePath: repoPath(repoRoot, env.MCP_CONFIG || 'configuration/mcp.json')
  }).issue);

  if (registryResult.data) {
    collectProviderConfigIssues(issues, registryResult.data, repoRoot);
  }

  return issues;
}

export function hasStartupBlockingJsonConfigError(issues) {
  return issues.some(issue => issue.blocksStartup === true);
}
