import { ACP_UX_TOOL_NAMES } from '../services/tools/acpUxTools.js';

export function getInvokeShellMcpToolDefinition() {
  return {
    name: ACP_UX_TOOL_NAMES.invokeShell,
    title: 'Interactive shell',
    description: 'Execute a shell command in a real terminal with live streaming output and user-interactive stdin while the process is running. Always use this tool for shell commands; never use system shell, bash, or powershell tools when they are present. This is a full replacement for shell execution. Use for running build commands, tests, scripts, package installs, CLIs that may prompt, and other command-line operations. Multiple ux_invoke_shell calls may be invoked concurrently; each command gets its own terminal. Use parallel calls for independent commands that do not contend for the same files, ports, packages, or other shared resources. The tool call returns after the command exits or the user terminates it, and the terminal becomes read-only after exit.',
    annotations: {
      title: 'Interactive shell',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    _meta: {
      'acpui/concurrentInvocationsSupported': true
    },
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short description (1 sentence, 3-10 words) that will be displayed to the user when this command runs so they can understand the purpose of the command at a glance.'
        },
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (absolute path)' }
      },
      required: ['description', 'command']
    }
  };
}

export function getSubagentsMcpToolDefinition({ modelDescription = 'Optional model id to use for these agents.' } = {}) {
  return {
    name: ACP_UX_TOOL_NAMES.invokeSubagents,
    description: 'Spawn multiple visible AI sub-agents asynchronously. Returns after agents are spawned with an invocation ID and instructions to call ux_check_subagents for status/results or ux_abort_subagents to stop the running agents. Do not call this again for the same work while the invocation is still running.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: modelDescription
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
              cwd: { type: 'string', description: 'Working directory' }
            },
            required: ['prompt']
          }
        }
      },
      required: ['requests']
    }
  };
}

export function getCounselMcpToolDefinition() {
  return {
    name: ACP_UX_TOOL_NAMES.invokeCounsel,
    description: 'Spawn multiple AI sub-agents with different perspectives asynchronously to evaluate a question or decision. Returns an invocation ID and instructions to call ux_check_subagents for status/results or ux_abort_subagents to stop the running agents. Always includes Advocate, Critic, and Pragmatist; optional domain experts can be included.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, decision, or topic to evaluate from multiple perspectives' },
        architect: { type: 'boolean', description: 'Include a Software Architecture expert' },
        performance: { type: 'boolean', description: 'Include a Software Performance expert' },
        security: { type: 'boolean', description: 'Include a Software Security expert' },
        ux: { type: 'boolean', description: 'Include a Software UX expert' }
      },
      required: ['question']
    }
  };
}

export function getCheckSubagentsMcpToolDefinition() {
  return {
    name: ACP_UX_TOOL_NAMES.checkSubagents,
    description: 'Check an async sub-agent invocation. By default waits up to the configured timeout for running agents, then returns completed results plus any agents still in progress. Set waitForCompletion to false to return the current status immediately so the parent agent can continue other work in parallel.',
    annotations: {
      title: 'Check Subagents',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        invocationId: {
          type: 'string',
          description: 'The invocation ID returned by ux_invoke_subagents or ux_invoke_counsel.'
        },
        waitForCompletion: {
          type: 'boolean',
          default: true,
          description: 'When true, wait up to the configured timeout for agents to finish. When false, return the current status immediately without waiting.'
        }
      },
      required: ['invocationId']
    }
  };
}

export function getAbortSubagentsMcpToolDefinition() {
  return {
    name: ACP_UX_TOOL_NAMES.abortSubagents,
    description: 'Abort a running async sub-agent invocation, then return the same status/result payload shape as ux_check_subagents with completed results plus aborted agents.',
    annotations: {
      title: 'Abort Subagents',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        invocationId: {
          type: 'string',
          description: 'The invocation ID returned by ux_invoke_subagents or ux_invoke_counsel.'
        }
      },
      required: ['invocationId']
    }
  };
}
