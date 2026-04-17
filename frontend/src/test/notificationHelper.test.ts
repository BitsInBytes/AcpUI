import { describe, it, expect } from 'vitest';
import { shouldNotify } from '../utils/notificationHelper';

const workspaces = [{ path: '/home/user/project', label: 'MyProject' }];
const settings = { notificationSound: true, notificationDesktop: true };

describe('shouldNotify', () => {
  it('returns null when sessionId matches activeAcpId', () => {
    expect(shouldNotify('acp-1', 'acp-1', 'Session', workspaces, null, settings)).toBeNull();
  });

  it('returns notification result for background session', () => {
    const result = shouldNotify('acp-1', 'acp-2', 'My Session', workspaces, null, settings);
    expect(result).toEqual({ shouldSound: true, shouldDesktop: true, body: 'My Session agent has finished' });
  });

  it('includes workspace label in body when cwd matches', () => {
    const result = shouldNotify('acp-1', 'acp-2', 'My Session', workspaces, '/home/user/project', settings);
    expect(result!.body).toBe('My Session (MyProject) agent has finished');
  });

  it('excludes workspace label when no cwd match', () => {
    const result = shouldNotify('acp-1', 'acp-2', 'My Session', workspaces, '/other/path', settings);
    expect(result!.body).toBe('My Session agent has finished');
  });

  it('respects sound/desktop settings independently', () => {
    const result = shouldNotify('acp-1', 'acp-2', 'S', workspaces, null, { notificationSound: false, notificationDesktop: true });
    expect(result).toEqual({ shouldSound: false, shouldDesktop: true, body: 'S agent has finished' });
  });

  it('returns null when sessionName is undefined', () => {
    expect(shouldNotify('acp-1', 'acp-2', undefined, workspaces, null, settings)).toBeNull();
  });
});
