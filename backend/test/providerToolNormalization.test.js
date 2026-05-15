import { describe, expect, it } from 'vitest';
import {
  commandFromRawInput,
  collectToolNameCandidates,
  inputFromToolUpdate,
  mcpInvocationFromRaw,
  prettyToolTitle,
  resolveToolNameFromAcpUiMcpTitle,
  resolveToolNameFromCandidates,
  resolvePatternToolName,
  toolTitleDetailFromInput
} from '../services/tools/providerToolNormalization.js';

describe('providerToolNormalization', () => {
  const config = { toolIdPattern: 'mcp__{mcpName}__{toolName}' };

  it('builds input from standard update fields and optional deep values', () => {
    const input = inputFromToolUpdate({
      arguments: { pattern: 'TODO' },
      rawInput: {
        functionCall: {
          name: 'mcp__AcpUI__ux_grep_search',
          args: { description: 'Find TODOs' }
        }
      }
    }, { deep: true });

    expect(input).toEqual(expect.objectContaining({
      pattern: 'TODO',
      description: 'Find TODOs'
    }));
  });

  it('preserves advanced grep search input keys from nested provider payloads', () => {
    const input = inputFromToolUpdate({
      rawInput: {
        invocation: {
          tool: 'ux_grep_search',
          arguments: {
            pattern: 'TODO',
            case_mode: 'smart',
            include_globs: ['src/**/*.ts'],
            exclude_globs: ['dist/**'],
            file_types: ['ts'],
            before_context: 1,
            after_context: 2,
            max_matches: 3,
            result_mode: 'files',
            word_match: true,
            multiline: true,
            regex_engine: 'auto',
            hidden: true,
            no_ignore: true,
            follow_symlinks: false,
            fixed_strings: true
          }
        }
      }
    }, { deep: true });

    expect(input).toEqual(expect.objectContaining({
      pattern: 'TODO',
      case_mode: 'smart',
      include_globs: ['src/**/*.ts'],
      exclude_globs: ['dist/**'],
      file_types: ['ts'],
      before_context: 1,
      after_context: 2,
      max_matches: 3,
      result_mode: 'files',
      word_match: true,
      multiline: true,
      regex_engine: 'auto',
      hidden: true,
      no_ignore: true,
      follow_symlinks: false,
      fixed_strings: true
    }));
  });

  it('builds input from Gemini-style args and JSON description fields', () => {
    const input = inputFromToolUpdate({
      args: { url: 'https://example.test/docs' },
      description: '{"file_path":"D:/repo/hello.ts","pattern":"hello"}',
      toolCall: { args: { query: 'winnipeg weather' } }
    });

    expect(input).toEqual(expect.objectContaining({
      url: 'https://example.test/docs',
      file_path: 'D:/repo/hello.ts',
      pattern: 'hello',
      query: 'winnipeg weather'
    }));
  });

  it('extracts Codex-style MCP invocation metadata and command text', () => {
    const rawInput = {
      invocation: {
        server: 'AcpUI',
        tool: 'ux_invoke_shell',
        arguments: { command: ['npm', 'test'], cwd: 'D:/repo' }
      }
    };

    expect(mcpInvocationFromRaw(rawInput)).toEqual(expect.objectContaining({
      server: 'AcpUI',
      tool: 'ux_invoke_shell',
      arguments: { command: ['npm', 'test'], cwd: 'D:/repo' }
    }));
    expect(commandFromRawInput(rawInput)).toBe('npm test');
  });

  it('resolves AcpUI tool names from nested candidates and human MCP titles', () => {
    const candidates = collectToolNameCandidates({
      functionCall: { name: 'mcp__AcpUI__ux_read_file' }
    });

    expect(resolveToolNameFromCandidates(candidates, config)).toBe('ux_read_file');
    expect(resolveToolNameFromAcpUiMcpTitle('Read file')).toBe('ux_read_file');
    expect(resolveToolNameFromAcpUiMcpTitle('Check Subagents')).toBe('ux_check_subagents');
    expect(resolveToolNameFromAcpUiMcpTitle('Check Subagents: Quick status check')).toBe('ux_check_subagents');
    expect(resolveToolNameFromAcpUiMcpTitle('Abort Subagents')).toBe('ux_abort_subagents');
  });

  it('supports provider-owned suffix stripping patterns for tool ids', () => {
    expect(resolvePatternToolName('ux_read_file-1-2', config)).toBe('');
    expect(resolvePatternToolName('ux_read_file-1-2', config, {
      stripSuffixPatterns: [/-\d+-\d+$/]
    })).toBe('ux_read_file');
  });

  it('formats shared provider titles and detail values', () => {
    expect(prettyToolTitle('ux_invoke_shell')).toBe('Invoke Shell');
    expect(prettyToolTitle('ux_check_subagents')).toBe('Check Subagents');
    expect(prettyToolTitle('ux_abort_subagents')).toBe('Abort Subagents');
    expect(prettyToolTitle('spawn_helpers')).toBe('Spawn Helpers');
    expect(toolTitleDetailFromInput({ file_path: 'D:/repo/src/app.ts' })).toBe('app.ts');
    expect(toolTitleDetailFromInput({ pattern: 'use[A-Z]' })).toBe('use[A-Z]');
  });
});
