import { toolRegistry } from './toolRegistry.js';
import { shellToolHandler } from './handlers/shellToolHandler.js';
import { subAgentToolHandler } from './handlers/subAgentToolHandler.js';
import { counselToolHandler } from './handlers/counselToolHandler.js';
import { subAgentStatusToolHandler } from './handlers/subAgentStatusToolHandler.js';
import { ioToolHandler } from './handlers/ioToolHandler.js';
import { ACP_UX_IO_TOOL_NAMES, ACP_UX_TOOL_NAMES } from './acpUxTools.js';

toolRegistry.register(ACP_UX_TOOL_NAMES.invokeShell, shellToolHandler);
toolRegistry.register(ACP_UX_TOOL_NAMES.invokeSubagents, subAgentToolHandler);
toolRegistry.register(ACP_UX_TOOL_NAMES.invokeCounsel, counselToolHandler);
toolRegistry.register(ACP_UX_TOOL_NAMES.checkSubagents, subAgentStatusToolHandler);
toolRegistry.register(ACP_UX_TOOL_NAMES.abortSubagents, subAgentStatusToolHandler);
for (const toolName of ACP_UX_IO_TOOL_NAMES) {
  toolRegistry.register(toolName, ioToolHandler);
}

export { toolRegistry };
export { toolCallState } from './toolCallState.js';
export { mcpExecutionRegistry } from './mcpExecutionRegistry.js';
export { resolveToolInvocation, applyInvocationToEvent } from './toolInvocationResolver.js';
