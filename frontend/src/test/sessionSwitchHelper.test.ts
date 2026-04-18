import { describe, it, expect } from 'vitest';
import { computeSessionSwitch } from '../utils/sessionSwitchHelper';

const sessions = [
  { id: 's1', acpSessionId: 'acp-1' },
  { id: 's2', acpSessionId: 'acp-2' },
];

describe('computeSessionSwitch', () => {
  it('returns unwatch/watch ACP IDs for session switch', () => {
    const result = computeSessionSwitch({ prevSessionId: 's1', newSessionId: 's2', sessions, terminals: [], canvasOpenBySession: {} });
    expect(result.unwatchAcpId).toBe('acp-1');
    expect(result.watchAcpId).toBe('acp-2');
  });

  it('returns null ACP IDs when sessions not found', () => {
    const result = computeSessionSwitch({ prevSessionId: 'x', newSessionId: 'y', sessions, terminals: [], canvasOpenBySession: {} });
    expect(result.unwatchAcpId).toBeNull();
    expect(result.watchAcpId).toBeNull();
  });

  it('restores canvas open state from canvasOpenBySession', () => {
    const result = computeSessionSwitch({ prevSessionId: 's1', newSessionId: 's2', sessions, terminals: [], canvasOpenBySession: { s2: true } });
    expect(result.canvasOpen).toBe(true);
  });

  it('sets activeTerminalId from session terminals', () => {
    const result = computeSessionSwitch({ prevSessionId: 's1', newSessionId: 's2', sessions, terminals: [{ id: 't1', sessionId: 's2' }], canvasOpenBySession: {} });
    expect(result.activeTerminalId).toBe('t1');
  });

  it('canvas stays open when terminals exist even if not saved as open', () => {
    const result = computeSessionSwitch({ prevSessionId: 's1', newSessionId: 's2', sessions, terminals: [{ id: 't1', sessionId: 's2' }], canvasOpenBySession: {} });
    expect(result.canvasOpen).toBe(true);
  });
});
