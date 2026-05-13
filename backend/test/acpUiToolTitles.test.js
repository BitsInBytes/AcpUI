import { describe, expect, it } from 'vitest';
import { subAgentCheckToolTitle } from '../services/tools/acpUiToolTitles.js';

describe('acpUiToolTitles', () => {
  it('titles sub-agent status checks by wait mode', () => {
    expect(subAgentCheckToolTitle()).toBe('Check Subagents: Waiting for agents to finish');
    expect(subAgentCheckToolTitle({ waitForCompletion: true })).toBe('Check Subagents: Waiting for agents to finish');
    expect(subAgentCheckToolTitle({ waitForCompletion: false })).toBe('Check Subagents: Quick status check');
  });

  it('accepts alternate false encodings for quick sub-agent checks', () => {
    expect(subAgentCheckToolTitle({ wait_for_completion: false })).toBe('Check Subagents: Quick status check');
    expect(subAgentCheckToolTitle({ waitForCompletion: 'false' })).toBe('Check Subagents: Quick status check');
  });
});
