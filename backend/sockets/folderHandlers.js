import crypto from 'crypto';
import { getAllFolders, createFolder, renameFolder, deleteFolder, moveFolder, moveSessionToFolder } from '../database.js';
import { writeLog } from '../services/logger.js';

export default function registerFolderHandlers(io, socket) {
  socket.on('load_folders', async (callback) => {
    try {
      const folders = await getAllFolders();
      callback?.({ folders });
    } catch (err) {
      writeLog(`[FOLDER ERR] load: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('create_folder', async ({ name, parentId, providerId }, callback) => {
    try {
      const id = crypto.randomUUID();
      const folderName = name || 'New Folder';
      const folder = { id, name: folderName, parentId: parentId || null, position: 0, providerId: providerId || null };
      await createFolder(folder);
      callback?.({ folder });
    } catch (err) {
      writeLog(`[FOLDER ERR] create: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('rename_folder', async ({ id, name }, callback) => {
    try {
      await renameFolder(id, name);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[FOLDER ERR] rename: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('delete_folder', async ({ id }, callback) => {
    try {
      await deleteFolder(id);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[FOLDER ERR] delete: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('move_folder', async ({ id, newParentId }, callback) => {
    try {
      await moveFolder(id, newParentId || null);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[FOLDER ERR] move: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('move_session_to_folder', async ({ sessionId, folderId }, callback) => {
    try {
      await moveSessionToFolder(sessionId, folderId || null);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[FOLDER ERR] move session: ${err.message}`);
      callback?.({ error: err.message });
    }
  });
}
