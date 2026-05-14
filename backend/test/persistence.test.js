import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as db from '../database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB = path.join(__dirname, '..', `test-persistence-${process.pid}.db`);

describe('Persistence (Database)', () => {
  beforeEach(async () => {
    process.env.UI_DATABASE_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch (e) { /* ignore */ }
    }
    await db.initDb();
  });

  afterEach(async () => {
    await db.closeDb();
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch (e) { /* ignore */ }
    }
  });

  it('saves and retrieves sessions', async () => {
    const id = `s1-${Math.random()}`;
    const session = { id, acpSessionId: `a1-${Math.random()}`, name: 'Test', messages: [] };
    await db.saveSession(session);
    const retrieved = await db.getSession(id);
    expect(retrieved.name).toBe('Test');
  });

  it('retrieves pinned sessions', async () => {
    const p = `p-${Math.random()}`;
    await db.saveSession({ id: `s4-${Math.random()}`, acpSessionId: `a4-${Math.random()}`, isPinned: true, provider: p, messages: [] });
    const pinned = await db.getPinnedSessions(p);
    expect(pinned).toHaveLength(1);
  });

  it('saves config options without provider', async () => {
    const aid = `a5b-${Math.random()}`;
    const id = `s5b-${Math.random()}`;
    await db.saveSession({ id, acpSessionId: aid, messages: [] });
    await db.saveConfigOptions(aid, [{ id: 'o1', currentValue: 'v1' }]);
    const s = await db.getSession(id);
    expect(s.configOptions).toHaveLength(1);
  });

  it('saveConfigOptions returns immediately if nothing to change', async () => {
    await db.saveConfigOptions('a1', []);
    expect(true).toBe(true);
  });

  it('saveModelState handles null provider path', async () => {
    const aid = `a10-${Math.random()}`;
    const id = `s10-${Math.random()}`;
    await db.saveSession({ id, acpSessionId: aid, messages: [] });
    await db.saveModelState(aid, { currentModelId: 'm10' });
    const s = await db.getSession(id);
    expect(s.currentModelId).toBe('m10');
  });

  it('updates session name', async () => {
    const id = `s-name-${Math.random()}`;
    await db.saveSession({ id, messages: [] });
    await db.updateSessionName(id, 'New Name');
    const s = await db.getSession(id);
    expect(s.name).toBe('New Name');
  });

  it('handles getAllSessions without provider', async () => {
    await db.saveSession({ id: 's-no-p', messages: [] });
    const sessions = await db.getAllSessions();
    expect(sessions.some(s => s.id === 's-no-p')).toBe(true);
  });

  it('handles initDb twice', async () => {
    await db.initDb();
    expect(true).toBe(true);
  });

  it('handles canvas artifacts', async () => {
    const sid = `s-canvas-${Math.random()}`;
    const aid = `art-${Math.random()}`;
    await db.saveSession({ id: sid, messages: [] });
    await db.saveCanvasArtifact({ id: aid, sessionId: sid, title: 'Art', content: 'C' });
    const arts = await db.getCanvasArtifactsForSession(sid);
    expect(arts).toHaveLength(1);
    await db.deleteCanvasArtifact(aid);
  });

  it('retrieves session by acpId', async () => {
    const p = `p9-${Math.random()}`;
    const aid = `a9-${Math.random()}`;
    await db.saveSession({ id: 's9', acpSessionId: aid, provider: p, messages: [] });
    const s = await db.getSessionByAcpId(p, aid);
    expect(s.id).toBe('s9');
  });

  it('does not cross-resolve shared acp ids across providers', async () => {
    const aid = `a-shared-${Math.random()}`;
    await db.saveSession({ id: 's-shared-b', acpSessionId: aid, provider: 'provider-b', messages: [] });
    await db.saveSession({ id: 's-shared-null', acpSessionId: aid, messages: [] });

    const wrongProvider = await db.getSessionByAcpId('provider-a', aid);
    const rightProvider = await db.getSessionByAcpId('provider-b', aid);

    expect(wrongProvider).toBeNull();
    expect(rightProvider?.id).toBe('s-shared-b');
  });

  it('applies saveConfigOptions only to the matching provider row for shared acp ids', async () => {
    const aid = `a-config-shared-${Math.random()}`;
    await db.saveSession({ id: 's-config-a', acpSessionId: aid, provider: 'provider-a', messages: [] });
    await db.saveSession({ id: 's-config-b', acpSessionId: aid, provider: 'provider-b', messages: [] });

    await db.saveConfigOptions('provider-a', aid, [{ id: 'effort', currentValue: 'high' }]);

    const sessionA = await db.getSession('s-config-a');
    const sessionB = await db.getSession('s-config-b');
    expect(sessionA.configOptions).toEqual([{ id: 'effort', currentValue: 'high' }]);
    expect(sessionB.configOptions).toEqual([]);
  });

  it('handles notes', async () => {
    await db.saveSession({ id: 'sn', messages: [] });
    await db.saveNotes('sn', 'notes');
    expect(await db.getNotes('sn')).toBe('notes');
  });

  it('handles saveModelState with modelOptions and 3-arg signature', async () => {
    const aid = `a12-${Math.random()}`;
    await db.saveSession({ id: 's12', acpSessionId: aid, provider: 'p12', messages: [] });
    await db.saveModelState('p12', aid, { currentModelId: 'm12', modelOptions: [{ id: 'm1' }] });
    const s = await db.getSession('s12');
    expect(s.currentModelId).toBe('m12');
    expect(s.modelOptions).toHaveLength(1);
  });

  it('handles saveConfigOptions with 4-arg signature', async () => {
    const aid = `a11-${Math.random()}`;
    await db.saveSession({ id: 's11', acpSessionId: aid, provider: 'p11', messages: [] });
    await db.saveConfigOptions('p11', aid, [{ id: 'o11', currentValue: 'v11' }], { replace: true });
    const s = await db.getSession('s11');
    expect(s.configOptions).toHaveLength(1);
  });

  it('handles saveConfigOptions with invalid existing JSON', async () => {
    const aid = `a-fail-${Math.random()}`;
    await db.saveSession({ id: 's-fail', acpSessionId: aid, messages: [] });
    const sqlite3 = (await import('sqlite3')).default;
    const rawDb = new sqlite3.Database(process.env.UI_DATABASE_PATH);
    await new Promise((resolve) => {
      rawDb.run(`UPDATE sessions SET config_options_json = 'invalid' WHERE acp_id = ?`, [aid], () => resolve());
    });
    rawDb.close();

    await db.saveConfigOptions(null, aid, [{ id: 'o1', currentValue: 'v1' }]);
    const s = await db.getSession('s-fail');
    expect(s.configOptions).toHaveLength(1);
  });

  it('saves and retrieves the latest provider status by provider', async () => {
    const firstStatus = {
      providerId: 'provider-a',
      method: '_test.dev/provider/status',
      params: {
        providerId: 'provider-a',
        status: {
          providerId: 'provider-a',
          sections: [{ id: 'usage', items: [{ id: 'quota', label: 'Quota', value: '42%' }] }]
        }
      }
    };
    const secondStatus = {
      ...firstStatus,
      params: {
        ...firstStatus.params,
        status: {
          ...firstStatus.params.status,
          sections: [{ id: 'usage', items: [{ id: 'quota', label: 'Quota', value: '84%' }] }]
        }
      }
    };

    await db.saveProviderStatusExtension('provider-a', { method: '_test.dev/provider/status', params: { status: {} } });
    expect(await db.getProviderStatusExtensions()).toEqual([]);

    await db.saveProviderStatusExtension('provider-a', firstStatus);
    expect(await db.getProviderStatusExtension('provider-a')).toEqual(firstStatus);

    await db.saveProviderStatusExtension('provider-a', secondStatus);
    expect((await db.getProviderStatusExtension('provider-a')).params.status.sections[0].items[0].value).toBe('84%');
    expect(await db.getProviderStatusExtension('provider-b')).toBeNull();
    expect(await db.getProviderStatusExtensions()).toEqual([secondStatus]);
  });

  it('resolves provider status provider id from the extension payload', async () => {
    const status = {
      method: '_test.dev/provider/status',
      params: {
        status: {
          providerId: 'provider-from-status',
          sections: [{ id: 'usage', items: [{ id: 'quota', label: 'Quota', value: '42%' }] }]
        }
      }
    };

    await db.saveProviderStatusExtension(null, status);

    expect(await db.getProviderStatusExtension('provider-from-status')).toEqual({
      ...status,
      providerId: 'provider-from-status',
      params: {
        providerId: 'provider-from-status',
        status: {
          ...status.params.status,
          providerId: 'provider-from-status'
        }
      }
    });
  });

  it('keeps newer provider status when an older write arrives later', async () => {
    const statusAt2000 = {
      providerId: 'provider-a',
      method: '_test.dev/provider/status',
      params: {
        providerId: 'provider-a',
        status: {
          providerId: 'provider-a',
          sections: [{ id: 'usage', items: [{ id: 'quota', label: 'Quota', value: 'newer' }] }]
        }
      }
    };
    const statusAt1000 = {
      ...statusAt2000,
      params: {
        ...statusAt2000.params,
        status: {
          ...statusAt2000.params.status,
          sections: [{ id: 'usage', items: [{ id: 'quota', label: 'Quota', value: 'older' }] }]
        }
      }
    };
    const nowSpy = vi.spyOn(Date, 'now');

    try {
      nowSpy.mockReturnValueOnce(2000);
      await db.saveProviderStatusExtension('provider-a', statusAt2000);
      nowSpy.mockReturnValueOnce(1000);
      await db.saveProviderStatusExtension('provider-a', statusAt1000);
    } finally {
      nowSpy.mockRestore();
    }

    expect((await db.getProviderStatusExtension('provider-a')).params.status.sections[0].items[0].value).toBe('newer');
  });

  it('handles saveConfigOptions select error', async () => {
    const mockDb = {
      get: vi.fn((_q, _p, cb) => cb(new Error('select fail'))),
      serialize: vi.fn(fn => fn()),
      close: vi.fn(cb => cb(null))
    };
    db.setDbForTesting(mockDb);
    await expect(db.saveConfigOptions('a1', [{ id: 'o1' }])).rejects.toThrow('select fail');
  });
});
