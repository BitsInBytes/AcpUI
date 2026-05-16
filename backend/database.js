import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { writeLog } from './services/logger.js';
import { applyConfigOptionsChange, normalizeConfigOptions, normalizeRemovedConfigOptionIds } from './services/configOptions.js';
import { normalizeModelOptions } from './services/modelOptions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure env is loaded before checking process.env.UI_DATABASE_PATH
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

let db = null;
let dbInitializedPromise = null;

const ACTIVE_SUB_AGENT_INVOCATION_STATUSES = ['spawning', 'prompting', 'running', 'waiting_permission', 'cancelling'];
const TERMINAL_SUB_AGENT_INVOCATION_STATUSES = ['completed', 'failed', 'cancelled'];

// Initialize the database schema
export function initDb() {
  if (dbInitializedPromise) return dbInitializedPromise;

  const dbFile = process.env.UI_DATABASE_PATH || path.join(__dirname, '..', 'persistence.db');
  console.log(`[DB] Using SQLite database at: ${dbFile}`);
  db = new sqlite3.Database(dbFile);

  dbInitializedPromise = new Promise((resolve, reject) => {
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
          used_tokens REAL,
          total_tokens REAL,
          config_options_json TEXT,
          current_model_id TEXT,
          model_options_json TEXT,
          provider TEXT
        )
      `);

      // 2. Migrations for sessions table (individual runs, ignoring "already exists" errors)
      db.run(`ALTER TABLE sessions ADD COLUMN is_pinned INTEGER DEFAULT 0`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN config_options_json TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN current_model_id TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN model_options_json TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN provider TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN cwd TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN folder_id TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN notes TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN forked_from TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN fork_point INTEGER`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN is_sub_agent INTEGER DEFAULT 0`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN parent_acp_session_id TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN used_tokens REAL`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`ALTER TABLE sessions ADD COLUMN total_tokens REAL`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });
      db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_provider_acp ON sessions(provider, acp_id)`, (err) => { if (err) writeLog(`[DB] Index error: ${err.message}`); });
      db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_acp ON sessions(acp_id)`, (err) => { if (err) writeLog(`[DB] Index error: ${err.message}`); });

      // 3. Async sub-agent invocation registry
      db.run(`
        CREATE TABLE IF NOT EXISTS subagent_invocations (
          invocation_id TEXT PRIMARY KEY,
          provider TEXT,
          parent_acp_session_id TEXT,
          parent_ui_id TEXT,
          status TEXT,
          total_count INTEGER DEFAULT 0,
          completed_count INTEGER DEFAULT 0,
          status_tool_name TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          completed_at INTEGER
        )
      `, (err) => { if (err) writeLog(`[DB] Table error: ${err.message}`); });
      db.run(`
        CREATE TABLE IF NOT EXISTS subagent_invocation_agents (
          invocation_id TEXT,
          acp_session_id TEXT,
          ui_id TEXT,
          idx INTEGER,
          name TEXT,
          prompt TEXT,
          agent TEXT,
          model TEXT,
          status TEXT,
          result_text TEXT,
          error_text TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          completed_at INTEGER,
          PRIMARY KEY(invocation_id, acp_session_id)
        )
      `, (err) => { if (err) writeLog(`[DB] Table error: ${err.message}`); });
      db.run(`CREATE INDEX IF NOT EXISTS idx_subagent_invocations_parent ON subagent_invocations(provider, parent_ui_id)`, (err) => { if (err) writeLog(`[DB] Index error: ${err.message}`); });
      db.run(`CREATE INDEX IF NOT EXISTS idx_subagent_agents_invocation ON subagent_invocation_agents(invocation_id)`, (err) => { if (err) writeLog(`[DB] Index error: ${err.message}`); });
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_active_parent
        ON subagent_invocations(provider, parent_ui_id)
        WHERE status IN ('spawning', 'prompting', 'running', 'waiting_permission', 'cancelling')
      `, (err) => { if (err) writeLog(`[DB] Index error: ${err.message}`); });

      // 4. Folders table
      db.run(`
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          parent_id TEXT,
          position INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE
        )
      `, (err) => { if (err) writeLog(`[DB] Table error: ${err.message}`); });
      db.run(`ALTER TABLE folders ADD COLUMN provider_id TEXT`, (err) => { if (err && !err.message.includes('duplicate')) writeLog(`[DB] Migration skip: ${err.message}`); });

      // 5. Provider status persistence
      db.run(`
        CREATE TABLE IF NOT EXISTS provider_status (
          provider TEXT PRIMARY KEY,
          extension_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `, (err) => { if (err) writeLog(`[DB] Table error: ${err.message}`); });

      // 6. Canvas Artifacts table
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

export function closeDb() {
  return new Promise((resolve, reject) => {
    if (!db) {
      dbInitializedPromise = null;
      return resolve();
    }
    db.close((err) => {
      if (err) reject(err);
      else {
        db = null;
        dbInitializedPromise = null;
        resolve();
      }
    });
  });
}

export function setDbForTesting(mock) {
  db = mock;
  dbInitializedPromise = Promise.resolve();
}

// Save or update a session
export function saveSession(session) {
  const { id, acpSessionId, name, model, messages, isPinned, cwd, folderId, forkedFrom, forkPoint, isSubAgent, parentAcpSessionId, configOptions, currentModelId, modelOptions, provider, stats } = session;
  const messagesJson = JSON.stringify(messages || []);
  const configOptionsJson = JSON.stringify(configOptions || []);
  const normalizedModelOptions = normalizeModelOptions(modelOptions);
  const modelOptionsJson = Array.isArray(modelOptions) ? JSON.stringify(normalizedModelOptions) : null;
  const usedTokens = Number.isFinite(Number(stats?.usedTokens)) ? Number(stats.usedTokens) : null;
  const totalTokens = Number.isFinite(Number(stats?.totalTokens)) ? Number(stats.totalTokens) : null;
  const lastActive = Date.now();
  const pinnedVal = isPinned ? 1 : 0;

  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO sessions (ui_id, acp_id, name, model, messages_json, last_active, is_pinned, cwd, folder_id, forked_from, fork_point, is_sub_agent, parent_acp_session_id, used_tokens, total_tokens, config_options_json, current_model_id, model_options_json, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ui_id) DO UPDATE SET
        acp_id = excluded.acp_id,
        name = excluded.name,
        model = excluded.model,
        messages_json = excluded.messages_json,
        last_active = excluded.last_active,
        is_pinned = excluded.is_pinned,
        cwd = excluded.cwd,
        folder_id = excluded.folder_id,
        used_tokens = COALESCE(excluded.used_tokens, used_tokens),
        total_tokens = COALESCE(excluded.total_tokens, total_tokens),
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
        provider = COALESCE(excluded.provider, provider)
    `, [id, acpSessionId, name, model, messagesJson, lastActive, pinnedVal, cwd || null, folderId || null, forkedFrom || null, forkPoint ?? null, isSubAgent ? 1 : 0, parentAcpSessionId || null, usedTokens, totalTokens, configOptionsJson, currentModelId || null, modelOptionsJson, provider || null], (err) => {
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
export function getAllSessions(provider = null, options = {}) {
  let query = `
    SELECT ui_id, acp_id, name, model, last_active, is_pinned, cwd, folder_id, forked_from, fork_point, is_sub_agent, parent_acp_session_id, used_tokens, total_tokens, config_options_json, provider,
           CASE WHEN notes IS NOT NULL AND notes != '' THEN 1 ELSE 0 END as has_notes
    FROM sessions
  `;
  const params = [];
  if (provider) {
    const aliases = Array.isArray(options.providerAliases) ? options.providerAliases.filter(Boolean) : [];
    const providers = [provider, ...aliases];
    query += ` WHERE provider IN (${providers.map(() => '?').join(', ')}) OR provider IS NULL `;
    params.push(...providers);
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
        stats: {
          sessionId: row.acp_id || '',
          sessionPath: 'Relative',
          model: row.model || 'Unknown',
          toolCalls: 0,
          successTools: 0,
          durationMs: 0,
          usedTokens: Number(row.used_tokens || 0),
          totalTokens: Number(row.total_tokens || 0),
          sessionSizeMb: 0
        },
        configOptions: parseJsonArray(row.config_options_json),
        currentModelId: row.current_model_id || null,
        modelOptions: normalizeModelOptions(parseJsonArray(row.model_options_json)),
        messages: [] // Lazy loaded
      })));
    });
  });
}

// Get only pinned sessions for a provider
export function getPinnedSessions(providerId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT ui_id, acp_id, name, model, last_active, is_pinned, cwd, folder_id, provider, used_tokens, total_tokens, config_options_json, current_model_id, model_options_json
      FROM sessions
      WHERE is_pinned = 1 AND (provider = ? OR provider IS NULL)
    `, [providerId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(row => ({
        id: row.ui_id,
        acpSessionId: row.acp_id,
        name: row.name,
        model: row.model,
        lastActive: row.last_active,
        isPinned: true,
        cwd: row.cwd || null,
        folderId: row.folder_id || null,
        provider: row.provider || null,
        stats: {
          sessionId: row.acp_id || '',
          sessionPath: 'Relative',
          model: row.model || 'Unknown',
          toolCalls: 0,
          successTools: 0,
          durationMs: 0,
          usedTokens: Number(row.used_tokens || 0),
          totalTokens: Number(row.total_tokens || 0),
          sessionSizeMb: 0
        },
        configOptions: parseJsonArray(row.config_options_json),
        currentModelId: row.current_model_id || null,
        modelOptions: normalizeModelOptions(parseJsonArray(row.model_options_json)),
        messages: []
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
        stats: {
          sessionId: row.acp_id || '',
          sessionPath: 'Relative',
          model: row.model || 'Unknown',
          toolCalls: 0,
          successTools: 0,
          durationMs: 0,
          usedTokens: Number(row.used_tokens || 0),
          totalTokens: Number(row.total_tokens || 0),
          sessionSizeMb: 0
        },
        configOptions: parseJsonArray(row.config_options_json),
        currentModelId: row.current_model_id || null,
        modelOptions: normalizeModelOptions(parseJsonArray(row.model_options_json)),
        messages: JSON.parse(row.messages_json || '[]')
      });
    });
  });
}

export function getSessionByAcpId(providerOrAcpId, maybeAcpId = null) {
  const hasProvider = maybeAcpId !== null && maybeAcpId !== undefined;
  const provider = hasProvider ? providerOrAcpId : null;
  const acpId = hasProvider ? maybeAcpId : providerOrAcpId;

  return new Promise((resolve, reject) => {
    const query = provider
      ? `SELECT * FROM sessions WHERE acp_id = ? AND provider = ? ORDER BY last_active DESC LIMIT 1`
      : `SELECT * FROM sessions WHERE acp_id = ? ORDER BY last_active DESC LIMIT 1`;
    const params = provider ? [acpId, provider] : [acpId];
    db.get(query, params, (err, row) => {
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
        stats: {
          sessionId: row.acp_id || '',
          sessionPath: 'Relative',
          model: row.model || 'Unknown',
          toolCalls: 0,
          successTools: 0,
          durationMs: 0,
          usedTokens: Number(row.used_tokens || 0),
          totalTokens: Number(row.total_tokens || 0),
          sessionSizeMb: 0
        },
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

export function isSubAgentInvocationActiveStatus(status) {
  return ACTIVE_SUB_AGENT_INVOCATION_STATUSES.includes(status);
}

export function isSubAgentInvocationTerminalStatus(status) {
  return TERMINAL_SUB_AGENT_INVOCATION_STATUSES.includes(status);
}

function mapSubAgentInvocationRow(row) {
  if (!row) return null;
  return {
    invocationId: row.invocation_id,
    provider: row.provider || null,
    parentAcpSessionId: row.parent_acp_session_id || null,
    parentUiId: row.parent_ui_id || null,
    status: row.status || null,
    totalCount: Number(row.total_count || 0),
    completedCount: Number(row.completed_count || 0),
    statusToolName: row.status_tool_name || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null
  };
}

function mapSubAgentInvocationAgentRow(row) {
  if (!row) return null;
  return {
    invocationId: row.invocation_id,
    acpSessionId: row.acp_session_id,
    uiId: row.ui_id || null,
    index: Number(row.idx || 0),
    name: row.name || null,
    prompt: row.prompt || '',
    agent: row.agent || null,
    model: row.model || null,
    status: row.status || null,
    resultText: row.result_text || null,
    errorText: row.error_text || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null
  };
}

function providerWhere(providerId, params) {
  if (providerId) {
    params.push(providerId);
    return 'provider = ?';
  }
  return 'provider IS NULL';
}

export function createSubAgentInvocation(record) {
  const now = Date.now();
  const createdAt = record.createdAt || now;
  const updatedAt = record.updatedAt || now;
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO subagent_invocations (
        invocation_id, provider, parent_acp_session_id, parent_ui_id, status,
        total_count, completed_count, status_tool_name, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.invocationId,
      record.provider || null,
      record.parentAcpSessionId || null,
      record.parentUiId || null,
      record.status || 'spawning',
      Number.isFinite(Number(record.totalCount)) ? Number(record.totalCount) : 0,
      Number.isFinite(Number(record.completedCount)) ? Number(record.completedCount) : 0,
      record.statusToolName || 'ux_check_subagents',
      createdAt,
      updatedAt,
      record.completedAt || null
    ], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function getSubAgentInvocation(providerId, invocationId) {
  const params = [];
  const providerClause = providerWhere(providerId, params);
  params.push(invocationId);
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM subagent_invocations WHERE ${providerClause} AND invocation_id = ?`, params, (err, row) => {
      if (err) reject(err);
      else resolve(mapSubAgentInvocationRow(row));
    });
  });
}

export function getSubAgentInvocationsForParent(providerId, parentUiId, parentAcpSessionId = null) {
  if (!parentUiId && !parentAcpSessionId) return Promise.resolve([]);
  const params = [];
  const providerClause = providerWhere(providerId, params);
  const parentClauses = [];
  if (parentUiId) {
    parentClauses.push('parent_ui_id = ?');
    params.push(parentUiId);
  }
  if (parentAcpSessionId) {
    parentClauses.push('parent_acp_session_id = ?');
    params.push(parentAcpSessionId);
  }
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT * FROM subagent_invocations
      WHERE ${providerClause} AND (${parentClauses.join(' OR ')})
      ORDER BY updated_at DESC
    `, params, (err, rows) => {
      if (err) reject(err);
      else resolve((rows || []).map(mapSubAgentInvocationRow));
    });
  });
}

export function getActiveSubAgentInvocationForParent(providerId, parentUiId) {
  if (!parentUiId) return Promise.resolve(null);
  const params = [];
  const providerClause = providerWhere(providerId, params);
  params.push(parentUiId, ...ACTIVE_SUB_AGENT_INVOCATION_STATUSES);
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT * FROM subagent_invocations
      WHERE ${providerClause} AND parent_ui_id = ? AND status IN (${ACTIVE_SUB_AGENT_INVOCATION_STATUSES.map(() => '?').join(', ')})
      ORDER BY updated_at DESC
      LIMIT 1
    `, params, (err, row) => {
      if (err) reject(err);
      else resolve(mapSubAgentInvocationRow(row));
    });
  });
}

export function updateSubAgentInvocationStatus(providerId, invocationId, status, counts = {}) {
  const now = Date.now();
  const totalCount = Number.isFinite(Number(counts.totalCount)) ? Number(counts.totalCount) : null;
  const completedCount = Number.isFinite(Number(counts.completedCount)) ? Number(counts.completedCount) : null;
  const completedAt = counts.completedAt !== undefined
    ? counts.completedAt
    : (isSubAgentInvocationTerminalStatus(status) ? now : null);
  const params = [status, totalCount, completedCount, now, completedAt, completedAt];
  const providerClause = providerWhere(providerId, params);
  params.push(invocationId);
  return new Promise((resolve, reject) => {
    db.run(`
      UPDATE subagent_invocations SET
        status = ?,
        total_count = COALESCE(?, total_count),
        completed_count = COALESCE(?, completed_count),
        updated_at = ?,
        completed_at = CASE WHEN ? IS NULL THEN completed_at ELSE ? END
      WHERE ${providerClause} AND invocation_id = ?
    `, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function addSubAgentInvocationAgent(record) {
  const now = Date.now();
  const createdAt = record.createdAt || now;
  const updatedAt = record.updatedAt || now;
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO subagent_invocation_agents (
        invocation_id, acp_session_id, ui_id, idx, name, prompt, agent, model,
        status, result_text, error_text, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(invocation_id, acp_session_id) DO UPDATE SET
        ui_id = excluded.ui_id,
        idx = excluded.idx,
        name = excluded.name,
        prompt = excluded.prompt,
        agent = excluded.agent,
        model = excluded.model,
        status = excluded.status,
        result_text = COALESCE(excluded.result_text, result_text),
        error_text = COALESCE(excluded.error_text, error_text),
        updated_at = excluded.updated_at,
        completed_at = COALESCE(excluded.completed_at, completed_at)
    `, [
      record.invocationId,
      record.acpSessionId,
      record.uiId || null,
      Number.isFinite(Number(record.index)) ? Number(record.index) : 0,
      record.name || null,
      record.prompt || '',
      record.agent || null,
      record.model || null,
      record.status || 'spawning',
      record.resultText || null,
      record.errorText || null,
      createdAt,
      updatedAt,
      record.completedAt || null
    ], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function updateSubAgentInvocationAgentStatus(providerId, invocationId, acpSessionId, patch = {}) {
  const now = Date.now();
  const completedAt = patch.completedAt !== undefined
    ? patch.completedAt
    : (TERMINAL_SUB_AGENT_INVOCATION_STATUSES.includes(patch.status) ? now : null);
  const params = [
    patch.status || null,
    patch.resultText || null,
    patch.errorText || null,
    now,
    completedAt,
    completedAt,
    acpSessionId
  ];
  const providerClauseParams = [];
  const providerClause = providerWhere(providerId, providerClauseParams);
  params.push(...providerClauseParams, invocationId);
  return new Promise((resolve, reject) => {
    db.run(`
      UPDATE subagent_invocation_agents SET
        status = COALESCE(?, status),
        result_text = COALESCE(?, result_text),
        error_text = COALESCE(?, error_text),
        updated_at = ?,
        completed_at = CASE WHEN ? IS NULL THEN completed_at ELSE ? END
      WHERE acp_session_id = ?
        AND invocation_id IN (SELECT invocation_id FROM subagent_invocations WHERE ${providerClause} AND invocation_id = ?)
    `, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function getSubAgentInvocationWithAgents(providerId, invocationId) {
  return getSubAgentInvocation(providerId, invocationId).then(invocation => {
    if (!invocation) return null;
    const params = [invocationId];
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM subagent_invocation_agents
        WHERE invocation_id = ?
        ORDER BY idx ASC
      `, params, (err, rows) => {
        if (err) reject(err);
        else resolve({ ...invocation, agents: (rows || []).map(mapSubAgentInvocationAgentRow) });
      });
    });
  });
}

export function deleteSubAgentInvocation(providerId, invocationId) {
  const params = [];
  const providerClause = providerWhere(providerId, params);
  params.push(invocationId);
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM subagent_invocation_agents WHERE invocation_id = ?`, [invocationId], (agentErr) => {
      if (agentErr) { reject(agentErr); return; }
      db.run(`DELETE FROM subagent_invocations WHERE ${providerClause} AND invocation_id = ?`, params, (invErr) => {
        if (invErr) reject(invErr);
        else resolve();
      });
    });
  });
}

export function deleteSubAgentInvocationsForParent(providerId, parentUiId) {
  if (!parentUiId) return Promise.resolve();
  const params = [];
  const providerClause = providerWhere(providerId, params);
  params.push(parentUiId);
  return new Promise((resolve, reject) => {
    db.run(`
      DELETE FROM subagent_invocation_agents
      WHERE invocation_id IN (
        SELECT invocation_id FROM subagent_invocations WHERE ${providerClause} AND parent_ui_id = ?
      )
    `, params, (agentErr) => {
      if (agentErr) { reject(agentErr); return; }
      db.run(`DELETE FROM subagent_invocations WHERE ${providerClause} AND parent_ui_id = ?`, params, (invErr) => {
        if (invErr) reject(invErr);
        else resolve();
      });
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
        id: r.id, name: r.name, parentId: r.parent_id || null, position: r.position, providerId: r.provider_id || null
      })) || []);
    });
  });
}

export function createFolder(folder) {
  const { id, name, parentId, position, providerId } = folder;
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO folders (id, name, parent_id, position, provider_id) VALUES (?, ?, ?, ?, ?)`,
      [id, name, parentId || null, position || 0, providerId || null], (err) => {
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

function mapProviderStatusRow(row) {
  if (!row?.extension_json) return null;
  try {
    const extension = JSON.parse(row.extension_json);
    return extension && typeof extension === 'object' ? extension : null;
  } catch {
    return null;
  }
}

export function saveProviderStatusExtension(providerId, extension) {
  const params = extension?.params && typeof extension.params === 'object' ? extension.params : {};
  const status = params.status && typeof params.status === 'object' ? params.status : null;
  const resolvedProviderId = providerId || extension?.providerId || params.providerId || status?.providerId || null;

  if (!resolvedProviderId || !extension || typeof extension !== 'object' || !status || !Array.isArray(status.sections)) {
    return Promise.resolve();
  }

  const normalizedExtension = {
    ...extension,
    providerId: resolvedProviderId,
    params: {
      ...params,
      providerId: resolvedProviderId,
      ...(status ? { status: { ...status, providerId: resolvedProviderId } } : {})
    }
  };
  const extensionJson = JSON.stringify(normalizedExtension);
  const updatedAt = Date.now();

  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO provider_status (provider, extension_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        extension_json = excluded.extension_json,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= provider_status.updated_at
    `, [resolvedProviderId, extensionJson, updatedAt], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function getProviderStatusExtension(providerId) {
  if (!providerId) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    db.get(`SELECT extension_json FROM provider_status WHERE provider = ?`, [providerId], (err, row) => {
      if (err) reject(err);
      else resolve(mapProviderStatusRow(row));
    });
  });
}

export function getProviderStatusExtensions() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT extension_json FROM provider_status ORDER BY updated_at DESC`, [], (err, rows) => {
      if (err) reject(err);
      else resolve((rows || []).map(mapProviderStatusRow).filter(Boolean));
    });
  });
}

function parseProviderScopedArgs(first, second, third, fourth) {
  if (typeof second === 'string') {
    return {
      provider: first,
      acpId: second,
      value: third,
      change: fourth || {}
    };
  }
  return {
    provider: null,
    acpId: first,
    value: second,
    change: third || {}
  };
}

export function saveConfigOptions(providerOrAcpId, acpIdOrConfigOptions, configOptionsOrChange = {}, maybeChange = {}) {
  const { provider, acpId, value: configOptions, change } = parseProviderScopedArgs(
    providerOrAcpId,
    acpIdOrConfigOptions,
    configOptionsOrChange,
    maybeChange
  );
  const incomingOptions = normalizeConfigOptions(configOptions);
  const removeOptionIds = normalizeRemovedConfigOptionIds(change.removeOptionIds);
  const replace = change.replace === true;

  if (incomingOptions.length === 0 && removeOptionIds.length === 0 && !replace) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const selectQuery = provider
      ? `SELECT config_options_json FROM sessions WHERE acp_id = ? AND provider = ? ORDER BY last_active DESC LIMIT 1`
      : `SELECT config_options_json FROM sessions WHERE acp_id = ? ORDER BY last_active DESC LIMIT 1`;
    const selectParams = provider ? [acpId, provider] : [acpId];
    db.get(selectQuery, selectParams, (selectErr, row) => {
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
      const updateQuery = provider
        ? `UPDATE sessions SET config_options_json = ? WHERE acp_id = ? AND provider = ?`
        : `UPDATE sessions SET config_options_json = ? WHERE acp_id = ?`;
      const updateParams = provider ? [json, acpId, provider] : [json, acpId];
      db.run(updateQuery, updateParams, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export function saveModelState(providerOrAcpId, acpIdOrModelState = {}, maybeModelState = {}) {
  const { provider, acpId, value: modelState } = parseProviderScopedArgs(
    providerOrAcpId,
    acpIdOrModelState,
    maybeModelState
  );
  const { currentModelId, modelOptions } = modelState || {};
  const normalizedModelOptions = normalizeModelOptions(modelOptions);
  const hasCurrentModelId = typeof currentModelId === 'string' && currentModelId.trim();
  const hasModelOptions = normalizedModelOptions.length > 0;

  if (!hasCurrentModelId && !hasModelOptions) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const query = provider ? `
      UPDATE sessions
      SET
        current_model_id = COALESCE(?, current_model_id),
        model_options_json = CASE
          WHEN ? IS NULL THEN model_options_json
          ELSE ?
        END
      WHERE acp_id = ? AND provider = ?
    ` : `
      UPDATE sessions
      SET
        current_model_id = COALESCE(?, current_model_id),
        model_options_json = CASE
          WHEN ? IS NULL THEN model_options_json
          ELSE ?
        END
      WHERE acp_id = ?
    `;
    const params = [
      hasCurrentModelId ? currentModelId : null,
      hasModelOptions ? JSON.stringify(normalizedModelOptions) : null,
      hasModelOptions ? JSON.stringify(normalizedModelOptions) : null,
      acpId,
      ...(provider ? [provider] : [])
    ];
    db.run(query, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
