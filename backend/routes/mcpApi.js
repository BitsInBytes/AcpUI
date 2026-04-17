import { Router } from 'express';
import { createToolHandlers } from '../mcp/mcpServer.js';
import { getProvider } from '../services/providerLoader.js';
import { writeLog } from '../services/logger.js';

/**
 * Internal API for the stdio MCP proxy.
 * The proxy forwards tool calls here; we execute them using the real tool handlers.
 *
 * IMPORTANT: If you add/rename/remove tools in mcpServer.js, you must also update
 * the JSON Schema definitions in the GET /tools response below, AND the proxy will
 * pick up the changes automatically on next ACP session creation.
 */
export default function createMcpApiRoutes(io, acpClient) {
  const router = Router();
  const tools = createToolHandlers(io, acpClient);

  /**
   * GET /tools — returns tool definitions with JSON Schema for the stdio proxy.
   * The proxy registers these with the ACP so the agent knows what tools are available.
   * SYNC THIS with the tool handlers in mcpServer.js when adding/changing tools.
   */
  router.get('/tools', (_req, res) => {
    const serverName = getProvider().config.mcpName || 'acpui';
    const toolList = [
      { name: 'run_shell_command', description: 'Execute a shell command with live streaming output. Always prefer this over the built-in shell tool. Use for running build commands, tests, scripts, or any CLI operation.', inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (absolute path)' },
        },
        required: ['command'],
      }},
      { name: 'invoke_sub_agents', description: 'Spawn and coordinate multiple AI agents in parallel. Each agent runs as a visible session in the UI. Returns when all agents complete.', inputSchema: {
        type: 'object',
        properties: {
          model: { 
            type: 'string', 
            description: `Optional model to use for these agents. Pass the model id. Available: ${Object.entries(getProvider().config.models).filter(([, v]) => typeof v === 'object' && v.displayName).map(([, v]) => `${v.displayName} (id: ${v.id})`).join(', ')}`
          },
          requests: {
            type: 'array',
            description: 'Array of sub-agent requests to run in parallel',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'The task prompt for this agent' },
                name: { type: 'string', description: 'Short display name for this agent' },
                agent: { type: 'string', description: 'Agent name' },
                cwd: { type: 'string', description: 'Working directory' },
              },
              required: ['prompt'],
            },
          },
        },
        required: ['requests'],
      }},
      { name: 'counsel', description: 'Spawn multiple AI sub-agents with different perspectives to evaluate a question or decision. Always includes Advocate (argues for), Critic (argues against), and Pragmatist (practical assessment). Optionally include domain experts.', inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, decision, or topic to evaluate from multiple perspectives' },
          architect: { type: 'boolean', description: 'Include a Software Architecture expert' },
          performance: { type: 'boolean', description: 'Include a Software Performance expert' },
          security: { type: 'boolean', description: 'Include a Software Security expert' },
          ux: { type: 'boolean', description: 'Include a Software UX expert' },
        },
        required: ['question'],
      }},
    ];
    res.json({ tools: toolList, serverName });
  });

  /**
   * POST /tool-call — executes a tool and returns the result.
   * No timeout — the stdio proxy waits as long as needed (no HTTP timeout issue).
   */
  router.post('/tool-call', async (req, res) => {
    req.setTimeout(0);
    res.setTimeout(0);
    if (req.socket) req.socket.setTimeout(0);

    const { tool: toolName, args } = req.body;
    writeLog(`[MCP API] Tool call: ${toolName}`);

    const handler = tools[toolName];
    if (!handler) {
      res.status(404).json({ error: `Unknown tool: ${toolName}` });
      return;
    }

    try {
      const result = await handler(args || {});
      writeLog(`[MCP API] Tool ${toolName} completed`);
      res.json(result);
    } catch (err) {
      writeLog(`[MCP API] Tool ${toolName} error: ${err.message}`);
      res.json({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
    }
  });

  return router;
}
