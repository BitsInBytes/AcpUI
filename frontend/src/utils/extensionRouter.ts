import type { SlashCommand } from '../store/useSystemStore';
import type { ProviderConfigOption } from '../types';

export type ExtensionResult =
  | { type: 'commands'; commands: SlashCommand[] }
  | { type: 'metadata'; sessionId: string; contextUsagePercentage: number }
  | { type: 'compaction_started'; sessionId: string }
  | { type: 'compaction_completed'; sessionId: string; summary: string | null }
  | { type: 'config_options'; sessionId: string; options: ProviderConfigOption[]; replace?: boolean; removeOptionIds?: string[] }
  | null;

/**
 * Route a provider extension event to a typed result.
 * Pure function — no store access, no side effects.
 */
export function routeExtension(
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  protocolPrefix: string,
  systemCommands: SlashCommand[],
  customCommands: { name: string; description: string; prompt?: string | null }[]
): ExtensionResult {
  if (!method.startsWith(protocolPrefix)) return null;

  const type = method.slice(protocolPrefix.length);

  if (type === 'commands/available' && params.commands) {
    const customCmds: SlashCommand[] = customCommands
      .filter(c => c.prompt)
      .map(c => ({ name: c.name, description: c.description, meta: { local: true } }));
    return { type: 'commands', commands: [...systemCommands, ...customCmds, ...params.commands] };
  }

  if (type === 'metadata' && params.contextUsagePercentage !== undefined) {
    return { type: 'metadata', sessionId: params.sessionId, contextUsagePercentage: params.contextUsagePercentage };
  }

  if (type === 'config_options' && (params.options || params.removeOptionIds)) {
    return {
      type: 'config_options',
      sessionId: params.sessionId,
      options: Array.isArray(params.options) ? params.options : [],
      replace: params.replace === true || params.mode === 'replace',
      removeOptionIds: Array.isArray(params.removeOptionIds) ? params.removeOptionIds : undefined
    };
  }

  if (type === 'compaction/status' && params.status) {
    if (params.status.type === 'started') {
      return { type: 'compaction_started', sessionId: params.sessionId };
    }
    if (params.status.type === 'completed') {
      return { type: 'compaction_completed', sessionId: params.sessionId, summary: params.summary || null };
    }
  }

  return null;
}
