import { ACP_UX_TOOL_NAMES } from '../acpUxTools.js';
import { subAgentCheckToolTitle } from '../acpUiToolTitles.js';

const TITLES = Object.freeze({
  [ACP_UX_TOOL_NAMES.abortSubagents]: 'Abort Subagents'
});

function titleFor(canonicalName, input, fallbackTitle) {
  if (canonicalName === ACP_UX_TOOL_NAMES.checkSubagents) {
    const computedTitle = subAgentCheckToolTitle(input);
    if (computedTitle.includes('Waiting') && fallbackTitle === 'Check Subagents: Quick status check') {
      return fallbackTitle;
    }
    return computedTitle;
  }
  return TITLES[canonicalName] || fallbackTitle || 'Sub-agent Status';
}

export const subAgentStatusToolHandler = {
  onStart(_ctx, invocation, event) {
    const canonicalName = invocation.identity?.canonicalName || event.canonicalName || event.toolName;
    return {
      ...event,
      title: titleFor(canonicalName, invocation.input, event.title),
      canonicalName
    };
  }
};
