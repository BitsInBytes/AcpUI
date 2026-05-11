import { toolRegistry } from './toolRegistry.js';
import { shellToolHandler } from './handlers/shellToolHandler.js';
import { subAgentToolHandler } from './handlers/subAgentToolHandler.js';
import { counselToolHandler } from './handlers/counselToolHandler.js';

toolRegistry.register('ux_invoke_shell', shellToolHandler);
toolRegistry.register('ux_invoke_subagents', subAgentToolHandler);
toolRegistry.register('ux_invoke_counsel', counselToolHandler);

export { toolRegistry };
export { toolCallState } from './toolCallState.js';
export { resolveToolInvocation, applyInvocationToEvent } from './toolInvocationResolver.js';
