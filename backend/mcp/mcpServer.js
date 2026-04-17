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

// eslint-disable-next-line no-control-regex
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[?]?[0-9;]*[a-zA-Z]/g, '');

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
export function createToolHandlers(io, acpClient) {
  const tools = {};

  tools.run_shell_command = async ({ command, cwd }) => {
    const workingDir = cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
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

      if (io) io.emit('tool_output_stream', { chunk: `$ ${command}\n` });

      proc.onData((data) => {
        output += data;
        if (io) io.emit('tool_output_stream', { chunk: data });
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

  tools.invoke_sub_agents = async ({ requests, model }) => {
  if (!acpClient || !io) {
    return { content: [{ type: 'text', text: 'Error: Sub-agent system not available' }] };
  }

  writeLog(`[SUB-AGENT] Spawning ${requests.length} sub-agent(s)`);
  const { models } = getProvider().config;
  const tierEntry = model
    ? Object.entries(models).find(([, v]) => typeof v === 'object' && v.id === model)
    : null;
  const modelId = tierEntry ? tierEntry[1].id : (models.subAgent || models.flagship.id);
  const resolvedModelKey = tierEntry
    ? tierEntry[0]
    : (Object.entries(models).find(([, v]) => typeof v === 'object' && v.id === modelId)?.[0] || models.default || 'flagship');
    let _aborted = false;
    const abortCallbacks = [];
    const onAbort = (cb) => abortCallbacks.push(cb);
    acpClient._abortSubAgents = () => { _aborted = true; abortCallbacks.forEach(cb => cb()); };

    const sendWithTimeout = (method, params, timeoutMs = 600000) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        onAbort(() => { clearTimeout(timer); reject(new Error('Aborted')); });
        acpClient.sendRequest(method, params).then(r => { clearTimeout(timer); resolve(r); }).catch(e => { clearTimeout(timer); reject(e); });
      });
    };

    // Create all sessions with a 1-second stagger to avoid overwhelming the ACP
    const setupPromises = requests.map((req, i) => {
      return new Promise(resolve => {
        setTimeout(async () => {
          const agentName = req.agent || getProvider().config.defaultSubAgentName;
          if (!agentName) { resolve({ subAcpId: null, index: i, req, error: 'No agent configured' }); return; }
          const cwd = req.cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();

          try {
            const result = await sendWithTimeout('session/new', { cwd, mcpServers: getMcpServers() }, 30000);
            const subAcpId = result.sessionId;
            writeLog(`[SUB-AGENT ${i}] Created session ${subAcpId} (agent: ${agentName})`);

            const uiId = `sub-${subAcpId}`;
            registerSubAgent(subAcpId, null, req.prompt, agentName);

            let parentUiId = null;
            if (acpClient.lastSubAgentParentAcpId) {
              const parentSession = await db.getSessionByAcpId(acpClient.lastSubAgentParentAcpId);
              if (parentSession) parentUiId = parentSession.id;
            }
            await db.saveSession({
              id: uiId, acpSessionId: subAcpId,
              name: req.name || `Agent ${i + 1}: ${req.prompt.slice(0, 50)}`,
              model: resolvedModelKey, messages: [], isPinned: false,
              isSubAgent: true, forkedFrom: parentUiId,
            });

            await sendWithTimeout('session/set_model', { sessionId: subAcpId, modelId }, 10000);

            acpClient.sessionMetadata.set(subAcpId, {
              model: modelId, toolCalls: 0, successTools: 0, startTime: Date.now(),
              usedTokens: 0, totalTokens: 0, promptCount: 0,
              lastResponseBuffer: '', lastThoughtBuffer: '',
              agentName, spawnContext: null, isSubAgent: true,
            });

            const sockets = await io.fetchSockets();
            for (const s of sockets) s.join(`session:${subAcpId}`);
            io.emit('sub_agent_started', {
              acpSessionId: subAcpId, uiId, parentUiId, index: i,
              name: req.name || `Agent ${i + 1}`,
              prompt: req.prompt, agent: agentName, model: resolvedModelKey,
            });

            if (agentName !== getProvider().config.defaultSystemAgentName) {
              const providerModule = await getProviderModule();
              await providerModule.setInitialAgent(acpClient, subAcpId, agentName);
            }

            resolve({ subAcpId, index: i, req });
          } catch (err) {
            writeLog(`[SUB-AGENT ${i}] Setup error: ${err.message}`);
            failSubAgent(`sub-${i}`);
            io.emit('sub_agent_completed', { acpSessionId: `sub-${i}`, index: i, error: err.message });
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
        io.emit('sub_agent_completed', { acpSessionId: s.subAcpId, index: s.index });
        writeLog(`[SUB-AGENT ${s.index}] Completed: ${s.subAcpId}`);
        cleanupAcpSession(s.subAcpId);
        acpClient.sessionMetadata.delete(s.subAcpId);
        return { index: s.index, response, error: null };
      } catch (err) {
        writeLog(`[SUB-AGENT ${s.index}] Error: ${err.message}`);
        failSubAgent(s.subAcpId);
        io.emit('sub_agent_completed', { acpSessionId: s.subAcpId, index: s.index, error: err.message });
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
   * Reuses the invoke_sub_agents infrastructure with structured role prompts from counsel.json.
   *
   * Agent list is built from counsel.json (loaded via counselConfig.js):
   *   - config.core[] agents are always included (Advocate, Critic, Pragmatist)
   *   - config.optional.{key} agents are added when the matching boolean flag is true
   * Each agent entry has { name, prompt } — the prompt defines the agent's perspective/role.
   *
   * Delegates to invoke_sub_agents so counsel agents get the same session lifecycle,
   * UI visibility, and cleanup as any other sub-agent.
   */
  tools.counsel = async ({ question, architect, performance, security, ux }) => {
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

    // Delegate to invoke_sub_agents — reuses all sub-agent infrastructure
    return tools.invoke_sub_agents({ requests });
  };

  return tools;
}
