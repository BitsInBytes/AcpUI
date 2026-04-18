import { describe, it, expect, beforeEach, vi } from 'vitest';

let mod: typeof import('../utils/terminalState');

beforeEach(async () => {
  vi.resetModules();
  mod = await import('../utils/terminalState');
});

describe('terminalState', () => {
  it('hasSpawnedTerminal returns false for unknown id', () => {
    expect(mod.hasSpawnedTerminal('t-1')).toBe(false);
  });

  it('addSpawnedTerminal marks terminal as spawned', () => {
    mod.addSpawnedTerminal('t-2');
    expect(mod.hasSpawnedTerminal('t-2')).toBe(true);
  });

  it('clearSpawnedTerminal removes terminal', () => {
    mod.addSpawnedTerminal('t-3');
    mod.clearSpawnedTerminal('t-3');
    expect(mod.hasSpawnedTerminal('t-3')).toBe(false);
  });

  it('clearSpawnedTerminal on unknown id does not throw', () => {
    expect(() => mod.clearSpawnedTerminal('nonexistent')).not.toThrow();
  });

  it('multiple terminals tracked independently', () => {
    mod.addSpawnedTerminal('a');
    mod.addSpawnedTerminal('b');
    mod.clearSpawnedTerminal('a');
    expect(mod.hasSpawnedTerminal('a')).toBe(false);
    expect(mod.hasSpawnedTerminal('b')).toBe(true);
  });
});
