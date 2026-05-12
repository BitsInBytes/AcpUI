import { ACP_UX_TOOL_NAMES } from '../acpUxTools.js';

const TITLES = Object.freeze({
  [ACP_UX_TOOL_NAMES.checkSubagents]: 'Check Subagents',
  [ACP_UX_TOOL_NAMES.abortSubagents]: 'Abort Subagents'
});

export const subAgentStatusToolHandler = {
  onStart(_ctx, invocation, event) {
    const canonicalName = invocation.identity?.canonicalName || event.canonicalName || event.toolName;
    return {
      ...event,
      title: TITLES[canonicalName] || event.title || 'Sub-agent Status',
      canonicalName
    };
  }
};
