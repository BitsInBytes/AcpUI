import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Force test DB path BEFORE importing database module
process.env.UI_DATABASE_PATH = './test-persistence.db';

import * as db from '../database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB = path.join(__dirname, '..', 'test-persistence.db');

// Ensure clean slate
try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }

describe('Backend Persistence (SQLite)', () => {
  const testUiId = 'test-ui-id-' + Date.now();
  const testSession = {
    id: testUiId,
    acpSessionId: 'acp-uuid-123',
    name: 'Test Persistent Chat',
    model: 'balanced',
    messages: [
      { id: 'm1', role: 'user', content: 'Hello persistence' },
      { id: 'm2', role: 'assistant', content: 'I will remember this' }
    ]
  };

  beforeAll(async () => {
    await db.initDb();
  });

  it('should save a new session to the database', async () => {
    await db.saveSession(testSession);
    const saved = await db.getSession(testUiId);
    
    expect(saved).toBeDefined();
    expect(saved.name).toBe(testSession.name);
    expect(saved.messages.length).toBe(2);
    expect(saved.messages[0].content).toBe('Hello persistence');
  });

  it('should update an existing session', async () => {
    const updatedSession = {
      ...testSession,
      name: 'Renamed Chat',
      messages: [...testSession.messages, { id: 'm3', role: 'user', content: 'Third message' }]
    };

    await db.saveSession(updatedSession);
    const saved = await db.getSession(testUiId);
    
    expect(saved.name).toBe('Renamed Chat');
    expect(saved.messages.length).toBe(3);
  });

  it('should list all sessions metadata', async () => {
    const all = await db.getAllSessions();
    expect(all.length).toBeGreaterThan(0);
    
    const found = all.find(s => s.id === testUiId);
    expect(found).toBeDefined();
    expect(found.name).toBe('Renamed Chat');
    // Metadata should NOT include messages
    expect(found.messages).toEqual([]);
  });

  it('should get a session by acp_id', async () => {
    const found = await db.getSessionByAcpId(testSession.acpSessionId);
    expect(found).toBeDefined();
    expect(found.id).toBe(testUiId);
  });

  it('should update a session name', async () => {
    await db.updateSessionName(testUiId, 'Manually Updated Name');
    const saved = await db.getSession(testUiId);
    expect(saved.name).toBe('Manually Updated Name');
  });

  it('should delete a session', async () => {
    await db.deleteSession(testUiId);
    const saved = await db.getSession(testUiId);
    expect(saved).toBeNull();
  });

  it('should persist configOptions and filter by provider', async () => {
    const configOptions = [{ id: 'effort', currentValue: 'high' }];
    const sessionClaude = {
      id: 'ui-claude',
      acpSessionId: 'acp-claude',
      name: 'Claude Chat',
      model: 'balanced',
      messages: [],
      provider: 'Claude',
      configOptions
    };
    const sessionGemini = {
      id: 'ui-gemini',
      acpSessionId: 'acp-gemini',
      name: 'Gemini Chat',
      model: 'balanced',
      messages: [],
      provider: 'Gemini'
    };

    await db.saveSession(sessionClaude);
    await db.saveSession(sessionGemini);

    // Filter by Claude
    const claudeSessions = await db.getAllSessions('Claude');
    expect(claudeSessions.length).toBeGreaterThanOrEqual(1);
    expect(claudeSessions.find(s => s.id === 'ui-claude')).toBeDefined();
    expect(claudeSessions.find(s => s.id === 'ui-gemini')).toBeUndefined();

    // Check configOptions
    const savedClaude = claudeSessions.find(s => s.id === 'ui-claude');
    expect(savedClaude.configOptions).toEqual(configOptions);

    // Filter by Gemini
    const geminiSessions = await db.getAllSessions('Gemini');
    expect(geminiSessions.find(s => s.id === 'ui-gemini')).toBeDefined();
    expect(geminiSessions.find(s => s.id === 'ui-claude')).toBeUndefined();

    await db.deleteSession('ui-claude');
    await db.deleteSession('ui-gemini');
  });

  it('should merge configOptions and ignore empty updates', async () => {
    const configOptions = [{
      id: 'effort',
      name: 'Effort',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }
      ]
    }];

    await db.saveSession({
      id: 'ui-config-merge',
      acpSessionId: 'acp-config-merge',
      name: 'Config Merge',
      model: 'balanced',
      messages: [],
      provider: 'Claude',
      configOptions
    });

    await db.saveConfigOptions('acp-config-merge', []);
    expect((await db.getSession('ui-config-merge')).configOptions).toEqual(configOptions);

    await db.saveConfigOptions('acp-config-merge', [{ id: 'effort', currentValue: 'high' }]);
    const saved = await db.getSession('ui-config-merge');
    expect(saved.configOptions[0]).toEqual({
      ...configOptions[0],
      currentValue: 'high'
    });

    await db.deleteSession('ui-config-merge');
  });

  it('should persist current model id and discovered model options', async () => {
    await db.saveSession({
      id: 'ui-model-state',
      acpSessionId: 'acp-model-state',
      name: 'Model State',
      model: 'balanced',
      messages: [],
      currentModelId: 'default',
      modelOptions: [
        { id: 'default', name: 'Sonnet' },
        { id: 'opus', name: 'Opus', description: 'Most capable' }
      ]
    });

    let saved = await db.getSession('ui-model-state');
    expect(saved.currentModelId).toBe('default');
    expect(saved.modelOptions).toEqual([
      { id: 'default', name: 'Sonnet' },
      { id: 'opus', name: 'Opus', description: 'Most capable' }
    ]);

    await db.saveModelState('acp-model-state', {
      currentModelId: 'opus',
      modelOptions: [
        { id: 'opus', name: 'Opus Updated' },
        { id: 'haiku', name: 'Haiku' },
        { id: 'haiku', name: 'Duplicate Haiku' },
        { name: 'Invalid' }
      ]
    });

    saved = await db.getSessionByAcpId('acp-model-state');
    expect(saved.currentModelId).toBe('opus');
    expect(saved.modelOptions).toEqual([
      { id: 'opus', name: 'Opus Updated' },
      { id: 'haiku', name: 'Haiku' }
    ]);

    await db.saveModelState('acp-model-state', {});
    saved = await db.getSession('ui-model-state');
    expect(saved.currentModelId).toBe('opus');
    expect(saved.modelOptions).toEqual([
      { id: 'opus', name: 'Opus Updated' },
      { id: 'haiku', name: 'Haiku' }
    ]);

    await db.deleteSession('ui-model-state');
  });
});

describe('Backend Persistence - Canvas Artifacts (SQLite)', () => {
  const testUiId = 'test-session-for-canvas-' + Date.now();
  const testSession = {
    id: testUiId,
    acpSessionId: 'acp-canvas-123',
    name: 'Canvas Test Chat',
    model: 'balanced',
    messages: []
  };

  const artifact1 = {
    id: 'canvas-1',
    sessionId: testUiId,
    title: 'Test Code',
    content: 'console.log("hello");',
    language: 'javascript',
    version: 1,
    filePath: '/tmp/test.js'
  };

  beforeAll(async () => {
    await db.initDb();
    await db.saveSession(testSession); // Artifacts need a valid session due to FOREIGN KEY
  });

  afterAll(async () => {
    await db.deleteSession(testUiId); // Cascade delete should clean up artifacts
  });

  it('should save a new canvas artifact', async () => {
    await db.saveCanvasArtifact(artifact1);
    const artifacts = await db.getCanvasArtifactsForSession(testUiId);
    
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].id).toBe(artifact1.id);
    expect(artifacts[0].title).toBe(artifact1.title);
    expect(artifacts[0].content).toBe(artifact1.content);
    expect(artifacts[0].language).toBe(artifact1.language);
    expect(artifacts[0].filePath).toBe(artifact1.filePath);
  });

  it('should update an existing canvas artifact (UPSERT)', async () => {
    const updatedArtifact = {
      ...artifact1,
      content: 'console.log("updated");',
      version: 2
    };

    await db.saveCanvasArtifact(updatedArtifact);
    const artifacts = await db.getCanvasArtifactsForSession(testUiId);
    
    expect(artifacts.length).toBe(1); // Should not create a new row
    expect(artifacts[0].content).toBe('console.log("updated");');
    expect(artifacts[0].version).toBe(2);
  });

  it('should delete a canvas artifact', async () => {
    await db.deleteCanvasArtifact('canvas-1');
    const artifacts = await db.getCanvasArtifactsForSession(testUiId);
    expect(artifacts.length).toBe(0);
  });

  it('should retrieve multiple canvas artifacts sorted by date', async () => {
    // Wait 1 second to ensure SQLite CURRENT_TIMESTAMP is different
    await new Promise(r => setTimeout(r, 1000));
    
    const artifact2 = {
      id: 'canvas-2',
      sessionId: testUiId,
      title: 'Second Snippet',
      content: 'Hello World',
      language: 'markdown',
      version: 1
    };

    await db.saveCanvasArtifact(artifact2);
    const artifacts = await db.getCanvasArtifactsForSession(testUiId);
    
    expect(artifacts.length).toBe(1); // artifact1 was deleted
    expect(artifacts[0].id).toBe(artifact2.id);
  });
});

describe('Backend Persistence - Folders (SQLite)', () => {
  const ts = Date.now();
  it('should create and list folders', async () => {
    await db.createFolder({ id: `f1-${ts}`, name: 'Work', parentId: null, position: 0 });
    await db.createFolder({ id: `f2-${ts}`, name: 'Sub', parentId: `f1-${ts}`, position: 1 });
    const folders = await db.getAllFolders();
    const f1 = folders.find(f => f.id === `f1-${ts}`);
    expect(f1).toBeDefined();
    expect(f1.name).toBe('Work');
    expect(f1.parentId).toBeNull();
  });

  it('should rename a folder', async () => {
    await db.renameFolder(`f1-${ts}`, 'Projects');
    const folders = await db.getAllFolders();
    expect(folders.find(f => f.id === `f1-${ts}`).name).toBe('Projects');
  });

  it('should move a folder', async () => {
    await db.createFolder({ id: `f3-${ts}`, name: 'Other', parentId: null, position: 2 });
    await db.moveFolder(`f3-${ts}`, `f1-${ts}`);
    const folders = await db.getAllFolders();
    expect(folders.find(f => f.id === `f3-${ts}`).parentId).toBe(`f1-${ts}`);
  });

  it('should move session to folder', async () => {
    await db.saveSession({ id: `folder-s-${ts}`, name: 'Test', model: 'flagship', messages: [] });
    await db.moveSessionToFolder(`folder-s-${ts}`, `f1-${ts}`);
    const session = await db.getSession(`folder-s-${ts}`);
    expect(session.folderId).toBe(`f1-${ts}`);
  });

  it('should delete folder and reparent children', async () => {
    await db.deleteFolder(`f1-${ts}`);
    const folders = await db.getAllFolders();
    expect(folders.find(f => f.id === `f1-${ts}`)).toBeUndefined();
    const f2 = folders.find(f => f.id === `f2-${ts}`);
    expect(f2.parentId).toBeNull();
  });
});

describe('Backend Persistence - Notes (SQLite)', () => {
  const ts = Date.now();
  it('should save and get notes', async () => {
    await db.saveSession({ id: `notes-s1-${ts}`, name: 'Notes Test', model: 'flagship', messages: [] });
    await db.saveNotes(`notes-s1-${ts}`, '# Hello\nWorld');
    const notes = await db.getNotes(`notes-s1-${ts}`);
    expect(notes).toBe('# Hello\nWorld');
  });

  it('should return empty string for session with no notes', async () => {
    await db.saveSession({ id: `notes-s2-${ts}`, name: 'No Notes', model: 'flagship', messages: [] });
    const notes = await db.getNotes(`notes-s2-${ts}`);
    expect(notes).toBe('');
  });

  it('should include hasNotes in getAllSessions', async () => {
    const sessions = await db.getAllSessions();
    const withNotes = sessions.find(s => s.id === `notes-s1-${ts}`);
    const withoutNotes = sessions.find(s => s.id === `notes-s2-${ts}`);
    expect(withNotes?.hasNotes).toBe(true);
    expect(withoutNotes?.hasNotes).toBe(false);
  });
});

// Clean up test database file
afterAll(() => {
  try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
});
