import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSubAgent, completeSubAgent, failSubAgent,
  getSubAgent, getSubAgentsForParent, getAllRunning, removeSubAgentsForParent
} from '../mcp/subAgentRegistry.js';

describe('subAgentRegistry', () => {
  beforeEach(() => {
    removeSubAgentsForParent(null); // clear all
  });

  it('registerSubAgent adds entry', () => {
    registerSubAgent('sub-1', 'parent-1', 'do stuff', 'agent-dev');
    const entry = getSubAgent('sub-1');
    expect(entry).toEqual({ parentAcpSessionId: 'parent-1', prompt: 'do stuff', agent: 'agent-dev', status: 'running' });
  });

  it('completeSubAgent sets status', () => {
    registerSubAgent('sub-1', 'parent-1', 'p', 'a');
    completeSubAgent('sub-1');
    expect(getSubAgent('sub-1').status).toBe('completed');
  });

  it('failSubAgent sets status', () => {
    registerSubAgent('sub-1', 'parent-1', 'p', 'a');
    failSubAgent('sub-1');
    expect(getSubAgent('sub-1').status).toBe('failed');
  });

  it('getSubAgent returns entry', () => {
    registerSubAgent('sub-1', 'parent-1', 'p', 'a');
    expect(getSubAgent('sub-1')).toBeDefined();
    expect(getSubAgent('nonexistent')).toBeUndefined();
  });

  it('getSubAgentsForParent filters correctly', () => {
    registerSubAgent('sub-1', 'parent-1', 'p1', 'a');
    registerSubAgent('sub-2', 'parent-2', 'p2', 'a');
    registerSubAgent('sub-3', 'parent-1', 'p3', 'a');

    const result = getSubAgentsForParent('parent-1');
    expect(result).toHaveLength(2);
    expect(result.map(r => r.acpId)).toEqual(['sub-1', 'sub-3']);
  });

  it('getAllRunning returns only running', () => {
    registerSubAgent('sub-1', 'p', 'p1', 'a');
    registerSubAgent('sub-2', 'p', 'p2', 'a');
    completeSubAgent('sub-1');

    const running = getAllRunning();
    expect(running).toHaveLength(1);
    expect(running[0].acpId).toBe('sub-2');
  });

  it('removeSubAgentsForParent(null) clears all', () => {
    registerSubAgent('sub-1', 'p1', 'p', 'a');
    registerSubAgent('sub-2', 'p2', 'p', 'a');
    removeSubAgentsForParent(null);
    expect(getSubAgent('sub-1')).toBeUndefined();
    expect(getSubAgent('sub-2')).toBeUndefined();
  });

  it('removeSubAgentsForParent(id) removes only matching', () => {
    registerSubAgent('sub-1', 'parent-1', 'p', 'a');
    registerSubAgent('sub-2', 'parent-2', 'p', 'a');
    removeSubAgentsForParent('parent-1');
    expect(getSubAgent('sub-1')).toBeUndefined();
    expect(getSubAgent('sub-2')).toBeDefined();
  });
});
