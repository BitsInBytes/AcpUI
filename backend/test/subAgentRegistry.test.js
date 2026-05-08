import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSubAgent, completeSubAgent, failSubAgent,
  getSubAgent, getSubAgentsForParent, getAllRunning, removeSubAgentsForParent,
  setSpawningSubAgent, setPromptingSubAgent, cancelSubAgent
} from '../mcp/subAgentRegistry.js';

describe('subAgentRegistry', () => {
  beforeEach(() => {
    removeSubAgentsForParent(null); // clear all
  });

  it('registerSubAgent adds entry', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'parent-1', prompt: 'do stuff', agent: 'agent-dev', uiId: 'u-1', invocationId: 'inv-1', index: 0, name: 'n1', model: 'm1' });
    const entry = getSubAgent('sub-1');
    expect(entry).toEqual({ providerId: 'test-provider', parentAcpSessionId: 'parent-1', parentUiId: undefined, prompt: 'do stuff', agent: 'agent-dev', status: 'spawning', uiId: 'u-1', invocationId: 'inv-1', index: 0, name: 'n1', model: 'm1' });
  });

  it('setSpawningSubAgent sets status', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'p', prompt: 'p', agent: 'a' });
    setSpawningSubAgent('sub-1');
    expect(getSubAgent('sub-1').status).toBe('spawning');
  });

  it('setPromptingSubAgent sets status', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'p', prompt: 'p', agent: 'a' });
    setPromptingSubAgent('sub-1');
    expect(getSubAgent('sub-1').status).toBe('prompting');
  });

  it('cancelSubAgent sets status', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'p', prompt: 'p', agent: 'a' });
    cancelSubAgent('sub-1');
    expect(getSubAgent('sub-1').status).toBe('cancelled');
  });

  it('completeSubAgent sets status', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'parent-1', prompt: 'p', agent: 'a' });
    completeSubAgent('sub-1');
    expect(getSubAgent('sub-1').status).toBe('completed');
  });

  it('failSubAgent sets status', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'parent-1', prompt: 'p', agent: 'a' });
    failSubAgent('sub-1');
    expect(getSubAgent('sub-1').status).toBe('failed');
  });

  it('getSubAgent returns entry', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'parent-1', prompt: 'p', agent: 'a' });
    expect(getSubAgent('sub-1')).toBeDefined();
    expect(getSubAgent('nonexistent')).toBeUndefined();
  });

  it('getSubAgentsForParent filters correctly', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'parent-1', prompt: 'p1', agent: 'a' });
    registerSubAgent('test-provider', 'sub-2', { parentAcpSessionId: 'parent-2', prompt: 'p2', agent: 'a' });
    registerSubAgent('test-provider', 'sub-3', { parentAcpSessionId: 'parent-1', prompt: 'p3', agent: 'a' });

    const result = getSubAgentsForParent('parent-1', 'test-provider');
    expect(result).toHaveLength(2);
    expect(result.map(r => r.acpId)).toEqual(['sub-1', 'sub-3']);
  });

  it('getAllRunning returns only running', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'p', prompt: 'p1', agent: 'a' });
    registerSubAgent('test-provider', 'sub-2', { parentAcpSessionId: 'p', prompt: 'p2', agent: 'a' });
    completeSubAgent('sub-1');

    const running = getAllRunning('test-provider');
    expect(running).toHaveLength(1);
    expect(running[0].acpId).toBe('sub-2');
  });

  it('removeSubAgentsForParent(null) clears all', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'p1', prompt: 'p', agent: 'a' });
    registerSubAgent('test-provider', 'sub-2', { parentAcpSessionId: 'p2', prompt: 'p', agent: 'a' });
    removeSubAgentsForParent(null);
    expect(getSubAgent('sub-1')).toBeUndefined();
    expect(getSubAgent('sub-2')).toBeUndefined();
  });

  it('removeSubAgentsForParent(id) removes only matching', () => {
    registerSubAgent('test-provider', 'sub-1', { parentAcpSessionId: 'parent-1', prompt: 'p', agent: 'a' });
    registerSubAgent('test-provider', 'sub-2', { parentAcpSessionId: 'parent-2', prompt: 'p', agent: 'a' });
    removeSubAgentsForParent('parent-1', 'test-provider');
    expect(getSubAgent('sub-1')).toBeUndefined();
    expect(getSubAgent('sub-2')).toBeDefined();
  });
});
