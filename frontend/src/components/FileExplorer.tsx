import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FolderOpen, File, ChevronRight, ChevronDown, Save, Eye, Code } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Editor from '@monaco-editor/react';
import { useSystemStore } from '../store/useSystemStore';
import { useUIStore } from '../store/useUIStore';
import './FileExplorer.css';

interface DirEntry { name: string; isDirectory: boolean; }
interface TreeNode { name: string; path: string; isDirectory: boolean; children?: TreeNode[]; loaded?: boolean; }

const FileExplorer: React.FC = () => {
  const socket = useSystemStore(state => state.socket);
  const expandedProviderId = useUIStore(state => state.expandedProviderId);
  const systemProviderId = useSystemStore(state => state.activeProviderId || state.defaultProviderId);
  const providerId = expandedProviderId || systemProviderId;
  const isOpen = useUIStore(state => state.isFileExplorerOpen);
  const setOpen = useUIStore(state => state.setFileExplorerOpen);

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openFile, setOpenFile] = useState<{ path: string; content: string; original: string } | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [rootLabel, setRootLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDir = useCallback((dirPath: string, cb: (items: DirEntry[]) => void) => {
    socket?.emit('explorer_list', { ...(providerId ? { providerId } : {}), dirPath }, (res: { items?: DirEntry[] }) => {
      cb(res.items || []);
    });
  }, [socket, providerId]);

  // Load root on open
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isOpen || !socket) return;
    setTree([]);
    setExpanded(new Set());
    setOpenFile(null);
    setPreviewMode(false);
    setSaveError(null);
    const handleRoot = (res: { root?: string }) => {
      setRootLabel(res.root || '');
    };
    if (providerId) socket.emit('explorer_root', { providerId }, handleRoot);
    else socket.emit('explorer_root', handleRoot);
    loadDir('', (items) => {
      setTree(items.map(e => ({
        name: e.name, path: e.name, isDirectory: e.isDirectory,
        children: e.isDirectory ? [] : undefined
      })));
    });
  }, [isOpen, socket, providerId, loadDir]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const toggleDir = (node: TreeNode) => {
    const key = node.path;
    if (expanded.has(key)) {
      setExpanded(prev => { const n = new Set(prev); n.delete(key); return n; });
      return;
    }
    if (!node.loaded) {
      loadDir(node.path, (items) => {
        const children = items.map(e => ({
          name: e.name, path: `${node.path}/${e.name}`, isDirectory: e.isDirectory,
          children: e.isDirectory ? [] : undefined
        }));
        updateNode(node.path, { children, loaded: true });
      });
    }
    setExpanded(prev => new Set(prev).add(key));
  };

  const updateNode = (targetPath: string, updates: Partial<TreeNode>) => {
    setTree(prev => updateTreeNode(prev, targetPath, updates));
  };

  const openFileHandler = (filePath: string) => {
    socket?.emit('explorer_read', { ...(providerId ? { providerId } : {}), filePath }, (res: { content?: string }) => {
      const content = res.content || '';
      setOpenFile({ path: filePath, content, original: content });
      setPreviewMode(filePath.endsWith('.md'));
      setSaveError(null);
    });
  };

  const emitWrite = useCallback((filePath: string, content: string, onSuccess?: () => void) => {
    if (!socket) return;
    socket.emit(
      'explorer_write',
      { ...(providerId ? { providerId } : {}), filePath, content },
      (res: { success?: boolean; error?: string }) => {
        if (res?.success) {
          setSaveError(null);
          onSuccess?.();
          return;
        }
        setSaveError(res?.error || 'Failed to save file.');
      }
    );
  }, [socket, providerId]);

  const handleSave = () => {
    if (!openFile || !socket) return;
    setSaving(true);
    socket.emit(
      'explorer_write',
      { ...(providerId ? { providerId } : {}), filePath: openFile.path, content: openFile.content },
      (res: { success?: boolean; error?: string }) => {
        if (res?.success) {
          setSaveError(null);
          setOpenFile(prev => prev ? { ...prev, original: prev.content } : null);
        } else {
          setSaveError(res?.error || 'Failed to save file.');
        }
        setSaving(false);
      }
    );
  };

  const handleChange = (content: string) => {
    const currentPath = openFile?.path;
    setOpenFile(prev => prev ? { ...prev, content } : null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!currentPath) return;
      emitWrite(currentPath, content, () => {
        setOpenFile(prev => prev && prev.path === currentPath ? { ...prev, original: content } : prev);
      });
    }, 1500);
  };

  const isDirty = openFile ? openFile.content !== openFile.original : false;
  const isMarkdown = openFile?.path.endsWith('.md');

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="file-explorer-overlay" onClick={() => setOpen(false)}>
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.15 }}
          className="file-explorer-modal"
          onClick={e => e.stopPropagation()}
        >
          <div className="fe-header">
            <FolderOpen size={18} />
            <span className="fe-title">{rootLabel}</span>
            <button className="close-btn" onClick={() => setOpen(false)}><X size={20} /></button>
          </div>

          <div className="fe-body">
            <div className="fe-tree">
              {tree.map(node => (
                <TreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleDir}
                  onOpen={openFileHandler}
                  activeFile={openFile?.path}
                />
              ))}
            </div>

            <div className="fe-editor">
              {openFile ? (
                <>
                  <div className="fe-editor-header">
                    <span className="fe-file-path">{openFile.path}</span>
                    {isDirty && <span className="fe-dirty">●</span>}
                    <div className="fe-editor-actions">
                      {isMarkdown && (
                        <button
                          className={`fe-tab-btn ${previewMode ? 'active' : ''}`}
                          onClick={() => setPreviewMode(!previewMode)}
                          title={previewMode ? 'Edit' : 'Preview'}
                        >
                          {previewMode ? <Code size={14} /> : <Eye size={14} />}
                        </button>
                      )}
                      <button className="fe-save-btn" onClick={handleSave} disabled={!isDirty || saving}>
                        <Save size={14} /> {saving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    {saveError && <span className="fe-save-error" role="alert">{saveError}</span>}
                  </div>
                  <div className="fe-editor-content">
                    {previewMode && isMarkdown ? (
                      <div className="fe-md-preview">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{openFile.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <Editor
                        value={openFile.content}
                        language={getLanguage(openFile.path)}
                        theme="vs-dark"
                        onChange={(val) => handleChange(val || '')}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          lineNumbers: 'on',
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          automaticLayout: true,
                          readOnly: false,
                        }}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="fe-empty">Select a file to view or edit</div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

// Recursive tree item
const TreeItem: React.FC<{
  node: TreeNode; depth: number; expanded: Set<string>;
  onToggle: (n: TreeNode) => void; onOpen: (path: string) => void; activeFile?: string;
}> = ({ node, depth, expanded, onToggle, onOpen, activeFile }) => {
  const isExpanded = expanded.has(node.path);

  if (node.isDirectory) {
    return (
      <div>
        <div className="fe-tree-row" style={{ paddingLeft: `${depth * 16 + 8}px` }} onClick={() => onToggle(node)}>
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FolderOpen size={14} className="fe-folder-icon" />
          <span>{node.name}</span>
        </div>
        {isExpanded && node.children?.map(child => (
          <TreeItem key={child.path} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} activeFile={activeFile} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`fe-tree-row fe-file ${activeFile === node.path ? 'active' : ''}`}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onClick={() => onOpen(node.path)}
    >
      <File size={14} className="fe-file-icon" />
      <span>{node.name}</span>
    </div>
  );
};

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', md: 'markdown', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml',
  py: 'python', sh: 'shell', bash: 'shell', cs: 'csharp', xml: 'xml', sql: 'sql',
};

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return EXT_LANG[ext] || 'plaintext';
}

function updateTreeNode(nodes: TreeNode[], targetPath: string, updates: Partial<TreeNode>): TreeNode[] {
  return nodes.map(n => {
    if (n.path === targetPath) return { ...n, ...updates };
    if (n.children && targetPath.startsWith(n.path + '/')) {
      return { ...n, children: updateTreeNode(n.children, targetPath, updates) };
    }
    return n;
  });
}

export default FileExplorer;
