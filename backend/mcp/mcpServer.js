/**
 * MCP Tool Handlers.
 *
 * Plain async functions — no MCP SDK dependency.
 * The stdio proxy (stdio-proxy.js) handles the MCP protocol; these are the implementations.
 * Called via POST /api/mcp/tool-call from the proxy.
 *
 * Tool schemas (JSON Schema for the ACP) are defined separately in routes/mcpApi.js.
 * IMPORTANT: When adding/renaming/removing tools here, also update the schemas in mcpApi.js.
 *
 * Exports:
 *   getMcpServers()           — stdio MCP server config for session/new mcpServers array
 *   createToolHandlers(io, acpClient) — returns { toolName: handler(args) } map
 */
import { getProvider, getProviderModule } from '../services/providerLoader.js';
import { writeLog } from '../services/logger.js';
import pty from 'node-pty';
import { fileURLToPath } from 'url';
import path from 'path';
import { registerSubAgent, completeSubAgent, failSubAgent } from './subAgentRegistry.js';
import { cleanupAcpSession } from './acpCleanup.js';
import * as db from '../database.js';
import { loadCounselConfig } from '../services/counselConfig.js';
import { modelOptionsFromProviderConfig, resolveModelSelection } from '../services/modelOptions.js';

const DEFAULT_MAX_SHELL_RESULT_LINES = 1000;

// eslint-disable-next-line no-control-regex
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[?]?[0-9;]*[a-zA-Z]/g, '');

export function getMaxShellResultLines(env = process.env) {
  const parsed = Number.parseInt(env.MAX_SHELL_RESULT_LINES || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SHELL_RESULT_LINES;
}

/**
 * Returns the stdio MCP server config for passing in session/new mcpServers array.
 * The ACP spawns this as a child process and communicates via stdin/stdout.
 */
export function getMcpServers() {
  const name = getProvider().config.mcpName;
  if (!name) return [];
  const proxyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'stdio-proxy.js');
  return [{
    name,
    command: 'node',
    args: [proxyPath],
    env: [
      { name: 'BACKEND_PORT', value: String(process.env.BACKEND_PORT || 3005) },
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
    ]
  }];
}

/**
 * Creates tool handlers bound to io and acpClient.
 * Returns a map of { toolName: handler(args) }.
 */
import { providerRuntimeManager } from '../services/providerRuntimeManager.js';

export function createToolHandlers(io) {
  const tools = {};

  tools.ux_invoke_shell = async ({ command, cwd, providerId }) => {

    const workingDir = cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
    const maxLines = getMaxShellResultLines();
    // Unique ID for this specific shell invocation — lets the frontend route
    // tool_output_stream chunks to the correct ToolStep when multiple shells
    // run in parallel (without it, a single shared buffer causes output mixing).
    const shellId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    writeLog(`[MCP SHELL] Running: ${command} in ${workingDir}`);

    return new Promise((resolve) => {
      let output = '';
      let exitCode = 0;

      const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
      const args = process.platform === 'win32'
        ? ['-NoProfile', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`]
        : ['-c', command];

      const proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: workingDir,
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', PYTHONIOENCODING: 'utf-8' },
      });

      const emitToolOutput = (chunk) => {
        if (io) io.emit('tool_output_stream', { providerId, chunk, maxLines, shellId });
      };

      emitToolOutput(`$ ${command}\n`);

      proc.onData((data) => {
        output += data;
        emitToolOutput(data);
      });

      proc.onExit(({ exitCode: code }) => {
        exitCode = code;
        writeLog(`[MCP SHELL] Exit code: ${code}`);
        const plain = stripAnsi(output).trim() || '(no output)';
        const result = exitCode !== 0 ? `${plain}\n\nExit Code: ${exitCode}` : plain;
        resolve({ content: [{ type: 'text', text: result }] });
      });

      // Inactivity timeout: 30 minutes
      let timer = setTimeout(() => { proc.kill(); }, 1800000);
      proc.onData(() => { clearTimeout(timer); timer = setTimeout(() => { proc.kill(); }, 1800000); });
    });
  };

  tools.ux_invoke_subagents = async ({ requests, model, providerId }) => {
  if (!io) {
    return { content: [{ type: 'text', text: 'Error: Sub-agent system not available' }] };
  }

  writeLog(`[SUB-AGENT] Spawning ${requests.length} sub-agent(s)`);
  const provider = getProvider(providerId);
  const acpClient = providerRuntimeManager.getClient(providerId);
  if (!acpClient) return { content: [{ type: 'text', text: 'Error: Sub-agent system not available' }] };
  const models = provider.config.models || {};
  const quickModelOptions = modelOptionsFromProviderConfig(models);
  // Prefer the explicit model arg, then the provider's configured sub-agent model,
  // then fall through resolveModelSelection's chain (models.default → first quickAccess item).
  const modelId = resolveModelSelection(model || models.subAgent, models, quickModelOptions).modelId;
  const resolvedModelKey = modelId;

    // Unique ID for this specific invocation — threads through sub_agent_started events
    // so the frontend can correlate each agent with the ToolStep that spawned it.
    const invocationId = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Resolve parentUiId up front (before the 1-second stagger) so sub_agents_starting
    // can be emitted immediately, allowing the UI to clear old agent state right away.
    let parentUiId = null;
    if (acpClient.lastSubAgentParentAcpId) {
      const parentSession = await db.getSessionByAcpId(providerId, acpClient.lastSubAgentParentAcpId);
      if (parentSession) parentUiId = parentSession.id;
    }

    // Emit immediately — before the 1-second stagger — so the frontend clears stale
    // sub-agent panels without waiting for the first sub_agent_started event.
    io.emit('sub_agents_starting', { invocationId, parentUiId, providerId, count: requests.length });

    let _aborted = false;
    const abortCallbacks = [];
    const onAbort = (cb) => abortCallbacks.push(cb);
    acpClient._abortSubAgents = () => { _aborted = true; abortCallbacks.forEach(cb => cb()); };

    const sendWithTimeout = (method, params, timeoutMs = 600000) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        onAbort(() => { clearTimeout(timer); reject(new Error('Aborted')); });
        acpClient.transport.sendRequest(method, params).then(r => { clearTimeout(timer); resolve(r); }).catch(e => { clearTimeout(timer); reject(e); });
      });
    };

    // Create all sessions with a 1-second stagger to avoid overwhelming the ACP
    const setupPromises = requests.map((req, i) => {
      return new Promise(resolve => {
        setTimeout(async () => {
          const agentName = req.agent || getProvider(providerId).config.defaultSubAgentName;
          if (!agentName) { resolve({ subAcpId: null, index: i, req, error: 'No agent configured' }); return; }
          const cwd = req.cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();

          try {
            const providerModule = await getProviderModule();
            const sessionParams = providerModule.buildSessionParams(agentName);
            const result = await sendWithTimeout('session/new', { cwd, mcpServers: getMcpServers(), ...sessionParams }, 30000);
            const subAcpId = result.sessionId;
            writeLog(`[SUB-AGENT ${i}] Created session ${subAcpId} (agent: ${agentName})`);

            const uiId = `sub-${subAcpId}`;
            registerSubAgent(providerId, subAcpId, null, req.prompt, agentName);

            await db.saveSession({
              id: uiId, acpSessionId: subAcpId,
              name: req.name || `Agent ${i + 1}: ${req.prompt.slice(0, 50)}`,
              model: resolvedModelKey || null, messages: [], isPinned: false,
              isSubAgent: true, forkedFrom: parentUiId,
              currentModelId: modelId || null,
              modelOptions: quickModelOptions,
              provider: providerId,
            });

            if (modelId) {
              await sendWithTimeout('session/set_model', { sessionId: subAcpId, modelId }, 10000);
            }

            acpClient.sessionMetadata.set(subAcpId, {
              model: modelId || null, currentModelId: modelId || null, modelOptions: quickModelOptions,
              toolCalls: 0, successTools: 0, startTime: Date.now(),
              usedTokens: 0, totalTokens: 0, promptCount: 0,
              lastResponseBuffer: '', lastThoughtBuffer: '',
              agentName, spawnContext: null, isSubAgent: true,
            });

            const sockets = await io.fetchSockets();
            for (const s of sockets) s.join(`session:${subAcpId}`);
            io.emit('sub_agent_started', {
              providerId,
              acpSessionId: subAcpId, uiId, parentUiId, index: i,
              name: req.name || `Agent ${i + 1}`,
              prompt: req.prompt, agent: agentName, model: resolvedModelKey,
              invocationId,
            });

            if (agentName !== getProvider(providerId).config.defaultSystemAgentName) {
              await providerModule.setInitialAgent(acpClient, subAcpId, agentName);
            }

            resolve({ subAcpId, index: i, req });
          } catch (err) {
            writeLog(`[SUB-AGENT ${i}] Setup error: ${err.message}`);
            failSubAgent(`sub-${i}`);
            io.emit('sub_agent_completed', { providerId, acpSessionId: `sub-${i}`, index: i, error: err.message });
            resolve({ subAcpId: null, index: i, req, error: err.message });
          }
        }, i * 1000); // 1 second stagger
      });
    });

    const sessions2 = await Promise.all(setupPromises);

    const results = await Promise.all(sessions2.map(async (s) => {
      if (s.error) return { index: s.index, response: null, error: s.error };
      try {
        await sendWithTimeout('session/prompt', {
          sessionId: s.subAcpId,
          prompt: [{ type: 'text', text: s.req.prompt }]
        });
        const meta = acpClient.sessionMetadata.get(s.subAcpId);
        const response = meta?.lastResponseBuffer?.trim() || '(no response)';
        completeSubAgent(s.subAcpId);
        io.emit('sub_agent_completed', { providerId, acpSessionId: s.subAcpId, index: s.index });
        writeLog(`[SUB-AGENT ${s.index}] Completed: ${s.subAcpId}`);
        cleanupAcpSession(s.subAcpId, providerId);
        acpClient.sessionMetadata.delete(s.subAcpId);
        return { index: s.index, response, error: null };
      } catch (err) {
        writeLog(`[SUB-AGENT ${s.index}] Error: ${err.message}`);
        failSubAgent(s.subAcpId);
        io.emit('sub_agent_completed', { providerId, acpSessionId: s.subAcpId, index: s.index, error: err.message });
        return { index: s.index, response: null, error: err.message };
      }
    }));

    const summary = results.map((r, i) => {
      const header = `## Agent ${i + 1}`;
      if (r.error) return `${header}\nError: ${r.error}`;
      return `${header}\n${r.response}`;
    }).join('\n\n---\n\n');

    writeLog(`[SUB-AGENT] All ${requests.length} agents completed, returning summary (${summary.length} chars)`);
    acpClient._abortSubAgents = null;
    return { content: [{ type: 'text', text: summary }] };
  };

  /**
   * Counsel tool — spawns multiple sub-agents with different perspectives to evaluate a question.
   * Reuses the ux_invoke_subagents infrastructure with structured role prompts from counsel.json.
   *
   * Agent list is built from counsel.json (loaded via counselConfig.js):
   *   - config.core[] agents are always included (Advocate, Critic, Pragmatist)
   *   - config.optional.{key} agents are added when the matching boolean flag is true
   * Each agent entry has { name, prompt } — the prompt defines the agent's perspective/role.
   *
   * Delegates to ux_invoke_subagents so counsel agents get the same session lifecycle,
   * UI visibility, and cleanup as any other sub-agent.
   */
  tools.ux_invoke_counsel = async ({ question, architect, performance, security, ux, providerId }) => {
    const config = loadCounselConfig();
    // Core agents (e.g. Advocate, Critic, Pragmatist) are always spawned
    const agents = [...(config.core || [])];

    // Optional domain experts — toggled by boolean flags from the tool schema
    if (architect && config.optional?.architect) agents.push(config.optional.architect);
    if (performance && config.optional?.performance) agents.push(config.optional.performance);
    if (security && config.optional?.security) agents.push(config.optional.security);
    if (ux && config.optional?.ux) agents.push(config.optional.ux);

    if (!agents.length) {
      return { content: [{ type: 'text', text: 'Error: No counsel agents configured' }] };
    }

    // Each agent gets its role prompt prepended to the user's question
    const requests = agents.map(a => ({
      prompt: `${a.prompt}\n\nThe question/topic to evaluate:\n\n${question}`,
      name: a.name,
    }));

    // Delegate to ux_invoke_subagents — reuses all sub-agent infrastructure
    return tools.ux_invoke_subagents({ requests, providerId });
  };

  return tools;
}
