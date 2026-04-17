import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerFolderHandlers from '../sockets/folderHandlers.js';
import EventEmitter from 'events';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

const mockFolders = [
  { id: 'f1', name: 'Work', parentId: null, position: 0 },
  { id: 'f2', name: 'Personal', parentId: null, position: 1 },
];

vi.mock('../database.js', () => ({
  getAllFolders: vi.fn().mockResolvedValue([
    { id: 'f1', name: 'Work', parentId: null, position: 0 },
    { id: 'f2', name: 'Personal', parentId: null, position: 1 },
  ]),
  createFolder: vi.fn().mockResolvedValue(undefined),
  renameFolder: vi.fn().mockResolvedValue(undefined),
  deleteFolder: vi.fn().mockResolvedValue(undefined),
  moveFolder: vi.fn().mockResolvedValue(undefined),
  moveSessionToFolder: vi.fn().mockResolvedValue(undefined),
}));

describe('Folder Handlers', () => {
  let socket;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = new EventEmitter();
    registerFolderHandlers({}, socket);
  });

  it('load_folders returns all folders', async () => {
    const cb = vi.fn();
    await socket.listeners('load_folders')[0](cb);
    expect(cb).toHaveBeenCalledWith({ folders: expect.arrayContaining([expect.objectContaining({ id: 'f1' })]) });
  });

  it('create_folder creates and returns folder', async () => {
    const cb = vi.fn();
    await socket.listeners('create_folder')[0]({ name: 'Test', parentId: null }, cb);
    expect(cb).toHaveBeenCalledWith({ folder: expect.objectContaining({ name: 'Test', parentId: null }) });
  });

  it('create_folder defaults name to New Folder', async () => {
    const cb = vi.fn();
    await socket.listeners('create_folder')[0]({ parentId: null }, cb);
    expect(cb).toHaveBeenCalledWith({ folder: expect.objectContaining({ name: 'New Folder' }) });
  });

  it('rename_folder calls db and returns success', async () => {
    const cb = vi.fn();
    await socket.listeners('rename_folder')[0]({ id: 'f1', name: 'Renamed' }, cb);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('delete_folder calls db and returns success', async () => {
    const cb = vi.fn();
    await socket.listeners('delete_folder')[0]({ id: 'f1' }, cb);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('move_folder calls db and returns success', async () => {
    const cb = vi.fn();
    await socket.listeners('move_folder')[0]({ id: 'f2', newParentId: 'f1' }, cb);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('move_session_to_folder calls db and returns success', async () => {
    const cb = vi.fn();
    await socket.listeners('move_session_to_folder')[0]({ sessionId: 's1', folderId: 'f1' }, cb);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('handles errors gracefully', async () => {
    const { getAllFolders } = await import('../database.js');
    getAllFolders.mockRejectedValueOnce(new Error('db fail'));
    const cb = vi.fn();
    await socket.listeners('load_folders')[0](cb);
    expect(cb).toHaveBeenCalledWith({ error: 'db fail' });
  });
});


describe('Folder Handlers - Error Paths', () => {
  let socket;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = new EventEmitter();
    registerFolderHandlers({}, socket);
  });

  it('move_session_to_folder handles db error', async () => {
    const { moveSessionToFolder } = await import('../database.js');
    moveSessionToFolder.mockRejectedValueOnce(new Error('move fail'));
    const cb = vi.fn();
    await socket.listeners('move_session_to_folder')[0]({ sessionId: 's1', folderId: 'f1' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: 'move fail' });
  });

  it('move_session_to_folder passes null folderId when not provided', async () => {
    const { moveSessionToFolder } = await import('../database.js');
    const cb = vi.fn();
    await socket.listeners('move_session_to_folder')[0]({ sessionId: 's1', folderId: undefined }, cb);
    expect(moveSessionToFolder).toHaveBeenCalledWith('s1', null);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('delete_folder handles db error', async () => {
    const { deleteFolder } = await import('../database.js');
    deleteFolder.mockRejectedValueOnce(new Error('delete fail'));
    const cb = vi.fn();
    await socket.listeners('delete_folder')[0]({ id: 'f1' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: 'delete fail' });
  });

  it('create_folder handles db error', async () => {
    const { createFolder } = await import('../database.js');
    createFolder.mockRejectedValueOnce(new Error('create fail'));
    const cb = vi.fn();
    await socket.listeners('create_folder')[0]({ name: 'Test' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: 'create fail' });
  });

  it('rename_folder handles db error', async () => {
    const { renameFolder } = await import('../database.js');
    renameFolder.mockRejectedValueOnce(new Error('rename fail'));
    const cb = vi.fn();
    await socket.listeners('rename_folder')[0]({ id: 'f1', name: 'New' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: 'rename fail' });
  });

  it('move_folder handles db error', async () => {
    const { moveFolder } = await import('../database.js');
    moveFolder.mockRejectedValueOnce(new Error('move folder fail'));
    const cb = vi.fn();
    await socket.listeners('move_folder')[0]({ id: 'f1', newParentId: 'f2' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: 'move folder fail' });
  });

  it('move_folder passes null when newParentId is falsy', async () => {
    const { moveFolder } = await import('../database.js');
    const cb = vi.fn();
    await socket.listeners('move_folder')[0]({ id: 'f1', newParentId: '' }, cb);
    expect(moveFolder).toHaveBeenCalledWith('f1', null);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });
});
