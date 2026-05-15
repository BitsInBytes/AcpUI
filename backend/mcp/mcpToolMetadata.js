import {
  isCounselMcpEnabled,
  isGoogleSearchMcpEnabled,
  isInvokeShellMcpEnabled,
  isIoMcpEnabled,
  isSubagentsMcpEnabled
} from '../services/mcpConfig.js';
import {
  getAbortSubagentsMcpToolDefinition,
  getCheckSubagentsMcpToolDefinition,
  getCounselMcpToolDefinition,
  getInvokeShellMcpToolDefinition,
  getSubagentsMcpToolDefinition
} from './coreMcpToolDefinitions.js';
import { getGoogleSearchMcpToolDefinitions, getIoMcpToolDefinitions } from './ioMcpToolDefinitions.js';

export function getMcpToolEnablement() {
  const subagentsEnabled = isSubagentsMcpEnabled();
  const counselEnabled = isCounselMcpEnabled();
  return {
    invokeShell: isInvokeShellMcpEnabled(),
    subagents: subagentsEnabled,
    counsel: counselEnabled,
    subagentStatus: subagentsEnabled || counselEnabled,
    io: isIoMcpEnabled(),
    googleSearch: isGoogleSearchMcpEnabled()
  };
}

export function getAdvertisedMcpToolDefinitions({ modelDescription = 'Optional model id to use for these agents.' } = {}) {
  const enabled = getMcpToolEnablement();
  const toolList = [];

  if (enabled.invokeShell) {
    toolList.push(getInvokeShellMcpToolDefinition());
  }
  if (enabled.subagents) {
    toolList.push(getSubagentsMcpToolDefinition({ modelDescription }));
  }
  if (enabled.counsel) {
    toolList.push(getCounselMcpToolDefinition());
  }
  if (enabled.subagentStatus) {
    toolList.push(getCheckSubagentsMcpToolDefinition());
    toolList.push(getAbortSubagentsMcpToolDefinition());
  }
  if (enabled.io) {
    toolList.push(...getIoMcpToolDefinitions());
  }
  if (enabled.googleSearch) {
    toolList.push(...getGoogleSearchMcpToolDefinitions());
  }

  return toolList;
}

export function getAdvertisedMcpToolNames(options = {}) {
  return getAdvertisedMcpToolDefinitions(options).map(tool => tool.name);
}
