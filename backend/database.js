import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { applyConfigOptionsChange, normalizeConfigOptions, normalizeRemovedConfigOptionIds } from './services/configOptions.js';
import { normalizeModelOptions } from './services/modelOptions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure env is loaded before checking process.env.UI_DATABASE_PATH
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const dbFile = process.env.UI_DATABASE_PATH || path.join(__dirname, '..', 'persistence.db');
console.log(`[DB] Using SQLite database at: ${dbFile}`);
const db = new sqlite3.Database(dbFile);

// Initialize the database schema
export function initDb() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // 1. Core Sessions table
      db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          ui_id TEXT PRIMARY KEY,
          acp_id TEXT,
          name TEXT,
          model TEXT,
          messages_json TEXT,
          last_active INTEGER,
          is_pinned INTEGER DEFAULT 0,
          config_options_json TEXT,
          current_model_id TEXT,
          model_options_json TEXT,
          provider TEXT
        )
      `);

      // 2. Migrations for sessions table (individual runs, ignoring "already exists" errors)
      db.run(`ALTER TABLE sessions ADD COLUMN is_pinned INTEGER DEFAULT 0`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN config_options_json TEXT`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN current_model_id TEXT`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN model_options_json TEXT`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN provider TEXT`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN cwd TEXT`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN folder_id TEXT`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN notes TEXT`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN forked_from TEXT`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN fork_point INTEGER`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN is_sub_agent INTEGER DEFAULT 0`, () => {});
      db.run(`ALTER TABLE sessions ADD COLUMN parent_acp_session_id TEXT`, () => {});

      // 3. Folders table
      db.run(`
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          parent_id TEXT,
          position INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE
        )
      `);

      // 4. Canvas Artifacts table
      db.run(`
        CREATE TABLE IF NOT EXISTS canvas_artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          title TEXT,
          content TEXT,
          language TEXT,
          version INTEGER DEFAULT 1,
          file_path TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(session_id) REFERENCES sessions(ui_id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// Save or update a session
export function saveSession(session) {
  const { id, acpSessionId, name, model, messages, isPinned, cwd, folderId, forkedFrom, forkPoint, isSubAgent, parentAcpSessionId, configOptions, currentModelId, modelOptions, provider } = session;
  const messagesJson = JSON.stringify(messages || []);
  const configOptionsJson = JSON.stringify(configOptions || []);
  const normalizedModelOptions = normalizeModelOptions(modelOptions);
  const modelOptionsJson = Array.isArray(modelOptions) ? JSON.stringify(normalizedModelOptions) : null;
  const lastActive = Date.now();
  const pinnedVal = isPinned ? 1 : 0;

  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO sessions (ui_id, acp_id, name, model, messages_json, last_active, is_pinned, cwd, folder_id, forked_from, fork_point, is_sub_agent, parent_acp_session_id, config_options_json, current_model_id, model_options_json, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ui_id) DO UPDATE SET
        acp_id = excluded.acp_id,
        name = excluded.name,
        model = excluded.model,
        messages_json = excluded.messages_json,
        last_active = excluded.last_active,
        is_pinned = excluded.is_pinned,
        cwd = excluded.cwd,
        folder_id = excluded.folder_id,
        config_options_json = CASE
          WHEN excluded.config_options_json IS NULL OR excluded.config_options_json = '[]'
            THEN config_options_json
          ELSE excluded.config_options_json
        END,
        current_model_id = COALESCE(excluded.current_model_id, current_model_id),
        model_options_json = CASE
          WHEN excluded.model_options_json IS NULL OR excluded.model_options_json = '[]'
            THEN model_options_json
          ELSE excluded.model_options_json
        END,
        provider = excluded.provider
    `, [id, acpSessionId, name, model, messagesJson, lastActive, pinnedVal, cwd || null, folderId || null, forkedFrom || null, forkPoint ?? null, isSubAgent ? 1 : 0, parentAcpSessionId || null, configOptionsJson, currentModelId || null, modelOptionsJson, provider || null], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Get all session metadata (no heavy messages)
export function getAllSessions(provider = null) {
  let query = `
    SELECT ui_id, acp_id, name, model, last_active, is_pinned, cwd, folder_id, forked_from, fork_point, is_sub_agent, parent_acp_session_id, config_options_json, provider,
           CASE WHEN notes IS NOT NULL AND notes != '' THEN 1 ELSE 0 END as has_notes
    FROM sessions
  `;
  const params = [];
  if (provider) {
    query += ` WHERE provider = ? OR provider IS NULL `;
    params.push(provider);
  }
  query += ` ORDER BY is_pinned DESC, last_active DESC `;

  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(row => ({
        id: row.ui_id,
        acpSessionId: row.acp_id,
        name: row.name,
        model: row.model,
        lastActive: row.last_active,
        isPinned: row.is_pinned === 1,
        cwd: row.cwd || null,
        folderId: row.folder_id || null,
        forkedFrom: row.forked_from || null,
        forkPoint: row.fork_point ?? null,
        isSubAgent: row.is_sub_agent === 1,
        parentAcpSessionId: row.parent_acp_session_id || null,
        hasNotes: row.has_notes === 1,
        provider: row.provider || null,
        configOptions: parseJsonArray(row.config_options_json),
        currentModelId: row.current_model_id || null,
        modelOptions: normalizeModelOptions(parseJsonArray(row.model_options_json)),
        messages: [] // Lazy loaded
      })));
    });
  });
}

// Get full session data including messages
export function getSession(uiId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM sessions WHERE ui_id = ?`, [uiId], (err, row) => {
      if (err) reject(err);
      else if (!row) resolve(null);
      else resolve({
        id: row.ui_id,
        acpSessionId: row.acp_id,
        name: row.name,
        model: row.model,
        lastActive: row.last_active,
        isPinned: row.is_pinned === 1,
        cwd: row.cwd || null,
        folderId: row.folder_id || null,
        forkedFrom: row.forked_from || null,
        forkPoint: row.fork_point ?? null,
        isSubAgent: row.is_sub_agent === 1,
        parentAcpSessionId: row.parent_acp_session_id || null,
        provider: row.provider || null,
        configOptions: parseJsonArray(row.config_options_json),
        currentModelId: row.current_model_id || null,
        modelOptions: normalizeModelOptions(parseJsonArray(row.model_options_json)),
        messages: JSON.parse(row.messages_json || '[]')
      });
    });
  });
}

export function getSessionByAcpId(acpId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM sessions WHERE acp_id = ?`, [acpId], (err, row) => {
      if (err) reject(err);
      else if (!row) resolve(null);
      else resolve({
        id: row.ui_id,
        acpSessionId: row.acp_id,
        name: row.name,
        model: row.model,
        lastActive: row.last_active,
        isPinned: row.is_pinned === 1,
        cwd: row.cwd || null,
        folderId: row.folder_id || null,
        provider: row.provider || null,
        configOptions: parseJsonArray(row.config_options_json),
        currentModelId: row.current_model_id || null,
        modelOptions: normalizeModelOptions(parseJsonArray(row.model_options_json)),
        messages: JSON.parse(row.messages_json || '[]')
      });
    });
  });
}

export function updateSessionName(uiId, name) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE sessions SET name = ? WHERE ui_id = ?`, [name, uiId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Delete a session
export function deleteSession(uiId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM sessions WHERE ui_id = ?`, [uiId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Save or update a canvas artifact
export function saveCanvasArtifact(artifact) {
  const { id, sessionId, title, content, language, version, filePath } = artifact;
  
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO canvas_artifacts (id, session_id, title, content, language, version, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        title = excluded.title,
        content = excluded.content,
        language = excluded.language,
        version = excluded.version,
        file_path = excluded.file_path,
        created_at = CURRENT_TIMESTAMP
    `, [id, sessionId, title, content, language, version || 1, filePath || null], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
export function getCanvasArtifactsForSession(sessionId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, session_id as sessionId, title, content, language, version, file_path as filePath, created_at as createdAt 
       FROM canvas_artifacts 
       WHERE session_id = ? 
       ORDER BY created_at DESC`,
      [sessionId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

export function deleteCanvasArtifact(artifactId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM canvas_artifacts WHERE id = ?`,
      [artifactId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Folder operations
export function getAllFolders() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM folders ORDER BY position ASC`, (err, rows) => {
      if (err) reject(err);
      else resolve(rows?.map(r => ({
        id: r.id, name: r.name, parentId: r.parent_id || null, position: r.position
      })) || []);
    });
  });
}

export function createFolder(folder) {
  const { id, name, parentId, position } = folder;
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO folders (id, name, parent_id, position) VALUES (?, ?, ?, ?)`,
      [id, name, parentId || null, position || 0], (err) => {
        if (err) reject(err); else resolve();
      });
  });
}

export function renameFolder(id, name) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE folders SET name = ? WHERE id = ?`, [name, id], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

export function deleteFolder(id) {
  return new Promise((resolve, reject) => {
    // Move children to parent, unassign sessions, then delete
    db.get(`SELECT parent_id FROM folders WHERE id = ?`, [id], (err, row) => {
      if (err) return reject(err);
      const parentId = row?.parent_id || null;
      db.serialize(() => {
        db.run(`UPDATE folders SET parent_id = ? WHERE parent_id = ?`, [parentId, id]);
        db.run(`UPDATE sessions SET folder_id = ? WHERE folder_id = ?`, [parentId, id]);
        db.run(`DELETE FROM folders WHERE id = ?`, [id], (err) => {
          if (err) reject(err); else resolve();
        });
      });
    });
  });
}

export function moveFolder(id, newParentId) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE folders SET parent_id = ? WHERE id = ?`, [newParentId || null, id], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

export function moveSessionToFolder(sessionId, folderId) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE sessions SET folder_id = ? WHERE ui_id = ?`, [folderId || null, sessionId], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

export function getNotes(uiId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT notes FROM sessions WHERE ui_id = ?`, [uiId], (err, row) => {
      if (err) reject(err);
      else resolve(row?.notes || '');
    });
  });
}

export function saveNotes(uiId, notes) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE sessions SET notes = ? WHERE ui_id = ?`, [notes, uiId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function saveConfigOptions(acpId, configOptions, change = {}) {
  const incomingOptions = normalizeConfigOptions(configOptions);
  const removeOptionIds = normalizeRemovedConfigOptionIds(change.removeOptionIds);
  const replace = change.replace === true;

  if (incomingOptions.length === 0 && removeOptionIds.length === 0 && !replace) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    db.get(`SELECT config_options_json FROM sessions WHERE acp_id = ?`, [acpId], (selectErr, row) => {
      if (selectErr) {
        reject(selectErr);
        return;
      }

      let currentOptions;
      try {
        currentOptions = JSON.parse(row?.config_options_json || '[]');
      } catch {
        currentOptions = [];
      }

      const json = JSON.stringify(applyConfigOptionsChange(currentOptions, incomingOptions, { replace, removeOptionIds }));
      db.run(`UPDATE sessions SET config_options_json = ? WHERE acp_id = ?`, [json, acpId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export function saveModelState(acpId, { currentModelId, modelOptions } = {}) {
  const normalizedModelOptions = normalizeModelOptions(modelOptions);
  const hasCurrentModelId = typeof currentModelId === 'string' && currentModelId.trim();
  const hasModelOptions = normalizedModelOptions.length > 0;

  if (!hasCurrentModelId && !hasModelOptions) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    db.run(`
      UPDATE sessions
      SET
        current_model_id = COALESCE(?, current_model_id),
        model_options_json = CASE
          WHEN ? IS NULL THEN model_options_json
          ELSE ?
        END
      WHERE acp_id = ?
    `, [
      hasCurrentModelId ? currentModelId : null,
      hasModelOptions ? JSON.stringify(normalizedModelOptions) : null,
      hasModelOptions ? JSON.stringify(normalizedModelOptions) : null,
      acpId
    ], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
