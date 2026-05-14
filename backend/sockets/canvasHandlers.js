import fs from 'fs';
import path from 'path';
import { writeLog } from '../services/logger.js';
import * as db from '../database.js';
import { resolveAllowedPath } from '../services/ioMcp/filesystem.js';

export default function registerCanvasHandlers(io, socket) {
  socket.on('canvas_save', async (artifact, callback) => {
    try {
      writeLog(`[DB] Saving canvas artifact: ${artifact.id} for session ${artifact.sessionId}`);
      await db.saveCanvasArtifact(artifact);
      if (callback) callback({ success: true });
    } catch (err) {
      writeLog(`[DB ERR] Failed to save canvas artifact: ${err.message}`);
      if (callback) callback({ error: err.message });
    }
  });

  socket.on('canvas_load', async ({ sessionId }, callback) => {
    try {
      writeLog(`[DB] Loading canvas artifacts for session ${sessionId}`);
      const artifacts = await db.getCanvasArtifactsForSession(sessionId);
      if (callback) callback({ artifacts });
    } catch (err) {
      writeLog(`[DB ERR] Failed to load canvas artifacts: ${err.message}`);
      if (callback) callback({ error: err.message });
    }
  });

  socket.on('canvas_delete', async ({ artifactId }, callback) => {
    try {
      writeLog(`[DB] Deleting canvas artifact: ${artifactId}`);
      await db.deleteCanvasArtifact(artifactId);
      if (callback) callback({ success: true });
    } catch (err) {
      writeLog(`[DB ERR] Failed to delete canvas artifact: ${err.message}`);
      if (callback) callback({ error: err.message });
    }
  });

  socket.on('canvas_apply_to_file', async ({ filePath, content }, callback) => {
    try {
      const allowedPath = resolveAllowedPath(filePath, 'file_path');
      writeLog(`[FS] Applying canvas artifact to file: ${allowedPath}`);
      fs.writeFileSync(allowedPath, content, 'utf8');
      if (callback) callback({ success: true });
    } catch (err) {
      writeLog(`[FS ERR] Failed to apply to file: ${err.message}`);
      if (callback) callback({ error: err.message });
    }
  });

  socket.on('canvas_read_file', async ({ filePath }, callback) => {
    try {
      const allowedPath = resolveAllowedPath(filePath, 'file_path');
      writeLog(`[FS] Reading file for canvas: ${allowedPath}`);
      const content = fs.readFileSync(allowedPath, 'utf8');
      const language = path.extname(allowedPath).slice(1) || 'text';
      const title = path.basename(allowedPath);

      callback?.({
        artifact: {
          id: `canvas-fs-${Date.now()}`,
          title,
          content,
          language,
          filePath: allowedPath,
          version: 1
        }
      });
    } catch (err) {
      writeLog(`[FS ERR] Failed to read file for canvas: ${err.message}`);
      if (callback) callback({ error: err.message });
    }
  });
}
