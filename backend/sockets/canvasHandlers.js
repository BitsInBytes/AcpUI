import fs from 'fs';
import path from 'path';
import { writeLog } from '../services/logger.js';
import * as db from '../database.js';

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
      if (!filePath) throw new Error("No file path provided");
      writeLog(`[FS] Applying canvas artifact to file: ${filePath}`);
      fs.writeFileSync(filePath, content, 'utf8');
      if (callback) callback({ success: true });
    } catch (err) {
      writeLog(`[FS ERR] Failed to apply to file: ${err.message}`);
      if (callback) callback({ error: err.message });
    }
  });

  socket.on('canvas_read_file', async ({ filePath }, callback) => {
    try {
      if (!filePath) throw new Error("No file path provided");
      
      const resolvedPath = path.resolve(filePath);
      const finalPath = fs.existsSync(resolvedPath) ? fs.realpathSync(resolvedPath) : resolvedPath;
      
      writeLog(`[FS] Reading file for canvas: ${finalPath}`);
      const content = fs.readFileSync(finalPath, 'utf8');
      const language = path.extname(finalPath).slice(1) || 'text';
      const title = path.basename(finalPath);
      
      callback({ 
        artifact: {
          id: `canvas-fs-${Date.now()}`,
          title,
          content,
          language,
          filePath: finalPath,
          version: 1
        } 
      });
    } catch (err) {
      writeLog(`[FS ERR] Failed to read file for canvas: ${err.message}`);
      if (callback) callback({ error: err.message });
    }
  });
}
