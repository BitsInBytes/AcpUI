import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, CircleHelp, FileText, FolderOpen, Search, X } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useSystemStore } from '../store/useSystemStore';
import { useUIStore } from '../store/useUIStore';
import MemoizedMarkdown from './MemoizedMarkdown';
import './HelpDocsModal.css';

interface HelpDocEntry {
  name: string;
  path: string;
  directory: string;
}

interface HelpDocNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: HelpDocNode[];
}

interface HelpDocsListResponse {
  files?: HelpDocEntry[];
  root?: string;
  error?: string;
}

interface HelpDocsReadResponse {
  content?: string;
  filePath?: string;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
function renderMarkdownCode({ node: _node, inline, className, children, ...props }: any) {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';
  if (!inline && (match || String(children).includes('\n'))) {
    return (
      <SyntaxHighlighter style={vscDarkPlus} language={language} PreTag="div" className="syntax-highlighter">
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    );
  }
  return <code className={className} {...props}>{children}</code>;
}

const HelpDocsModal: React.FC = () => {
  const socket = useSystemStore(state => state.socket);
  const isOpen = useUIStore(state => state.isHelpDocsOpen);
  const setOpen = useUIStore(state => state.setHelpDocsOpen);

  const [files, setFiles] = useState<HelpDocEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [rootLabel, setRootLabel] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDocument = useCallback((filePath: string) => {
    if (!socket) return;
    setLoading(true);
    setError(null);
    socket.emit('help_docs_read', { filePath }, (res: HelpDocsReadResponse) => {
      if (res.error) {
        setContent('');
        setError(res.error);
      } else {
        setContent(res.content || '');
        setSelectedPath(res.filePath || filePath);
      }
      setLoading(false);
    });
  }, [socket]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isOpen || !socket) return;

    setFiles([]);
    setSelectedPath(null);
    setContent('');
    setRootLabel('');
    setQuery('');
    setExpanded(new Set());
    setError(null);
    setLoading(true);

    socket.emit('help_docs_list', {}, (res: HelpDocsListResponse) => {
      const nextFiles = res.files || [];
      setFiles(nextFiles);
      setRootLabel(res.root || 'Repository');
      if (res.error) setError(res.error);

      const initialFile = nextFiles.find(file => file.path === 'BOOTSTRAP.md') || nextFiles[0];
      if (initialFile) {
        setExpanded(parentDirectories(initialFile.path));
        loadDocument(initialFile.path);
      } else {
        setLoading(false);
      }
    });
  }, [isOpen, socket, loadDocument]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return files;
    return files.filter(file => file.path.toLowerCase().includes(normalizedQuery));
  }, [files, query]);

  const tree = useMemo(() => buildTree(filteredFiles), [filteredFiles]);
  const autoExpanded = query.trim() ? collectDirectoryPaths(tree) : expanded;
  const selectedFile = files.find(file => file.path === selectedPath);

  const markdownComponents = useMemo(() => ({
    code: renderMarkdownCode,
    a({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) {
      const targetPath = resolveMarkdownLink(href, selectedPath, files);
      if (!targetPath) return <a href={href} {...props}>{children}</a>;

      return (
        <a
          href={href}
          {...props}
          onClick={(event) => {
            event.preventDefault();
            setQuery('');
            setExpanded(parentDirectories(targetPath));
            loadDocument(targetPath);
          }}
        >
          {children}
        </a>
      );
    },
  }), [files, loadDocument, selectedPath]);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="help-docs-overlay" onClick={() => setOpen(false)}>
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.15 }}
          className="help-docs-modal"
          onClick={event => event.stopPropagation()}
        >
          <div className="hd-header">
            <CircleHelp size={18} />
            <span className="hd-title">Help</span>
            <span className="hd-root">{rootLabel}</span>
            <button className="close-btn" onClick={() => setOpen(false)} title="Close">
              <X size={20} />
            </button>
          </div>

          <div className="hd-body">
            <aside className="hd-sidebar">
              <label className="hd-search">
                <Search size={15} />
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="Search Markdown files"
                />
              </label>
              <div className="hd-tree" role="tree">
                {tree.map(node => (
                  <HelpDocTreeItem
                    key={node.path}
                    node={node}
                    depth={0}
                    expanded={autoExpanded}
                    activePath={selectedPath}
                    onToggle={(pathToToggle) => {
                      setExpanded(prev => {
                        const next = new Set(prev);
                        if (next.has(pathToToggle)) next.delete(pathToToggle);
                        else next.add(pathToToggle);
                        return next;
                      });
                    }}
                    onOpen={loadDocument}
                  />
                ))}
                {filteredFiles.length === 0 && <div className="hd-empty-list">No matching documents</div>}
              </div>
            </aside>

            <section className="hd-viewer">
              <div className="hd-viewer-header">
                <FileText size={16} />
                <span>{selectedFile?.path || 'No document selected'}</span>
              </div>
              <div className="hd-viewer-content markdown-body">
                {loading ? (
                  <div className="hd-empty-state">Loading...</div>
                ) : error ? (
                  <div className="hd-error">{error}</div>
                ) : selectedPath ? (
                  <MemoizedMarkdown key={selectedPath} content={content} isStreaming={false} components={markdownComponents} />
                ) : (
                  <div className="hd-empty-state">Select a Markdown document</div>
                )}
              </div>
            </section>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

const HelpDocTreeItem: React.FC<{
  node: HelpDocNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}> = ({ node, depth, expanded, activePath, onToggle, onOpen }) => {
  const isExpanded = expanded.has(node.path);

  if (node.isDirectory) {
    return (
      <div role="treeitem" aria-expanded={isExpanded}>
        <button className="hd-tree-row" style={{ paddingLeft: `${depth * 16 + 8}px` }} onClick={() => onToggle(node.path)}>
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FolderOpen size={14} className="hd-folder-icon" />
          <span>{node.name}</span>
        </button>
        {isExpanded && node.children?.map(child => (
          <HelpDocTreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            activePath={activePath}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </div>
    );
  }

  return (
    <button
      role="treeitem"
      className={`hd-tree-row hd-file ${activePath === node.path ? 'active' : ''}`}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onClick={() => onOpen(node.path)}
    >
      <FileText size={14} className="hd-file-icon" />
      <span>{node.name}</span>
    </button>
  );
};

function buildTree(files: HelpDocEntry[]): HelpDocNode[] {
  const root: HelpDocNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let currentLevel = root;
    let currentPath = '';

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      let node = currentLevel.find(item => item.name === part && item.isDirectory !== isFile);

      if (!node) {
        node = { name: part, path: currentPath, isDirectory: !isFile, children: isFile ? undefined : [] };
        currentLevel.push(node);
        currentLevel.sort(sortNodes);
      }

      if (!isFile) currentLevel = node.children || [];
    });
  }

  return root;
}

function sortNodes(a: HelpDocNode, b: HelpDocNode) {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function parentDirectories(filePath: string) {
  const parts = filePath.split('/').filter(Boolean);
  const dirs = new Set<string>();
  let currentPath = '';

  for (let i = 0; i < parts.length - 1; i += 1) {
    currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
    dirs.add(currentPath);
  }

  return dirs;
}

function collectDirectoryPaths(nodes: HelpDocNode[]) {
  const paths = new Set<string>();

  function visit(node: HelpDocNode) {
    if (!node.isDirectory) return;
    paths.add(node.path);
    node.children?.forEach(visit);
  }

  nodes.forEach(visit);
  return paths;
}

function resolveMarkdownLink(href: string | undefined, currentPath: string | null, files: HelpDocEntry[]) {
  if (!href || href.startsWith('#')) return null;

  const rawPath = getInternalHrefPath(href.trim());
  if (!rawPath) return null;

  const pathWithoutFragment = rawPath.split(/[?#]/)[0];
  if (!pathWithoutFragment.toLowerCase().endsWith('.md')) return null;

  const decodedPath = safeDecodeURIComponent(pathWithoutFragment).replace(/\\/g, '/');
  const fileByLowerPath = new Map(files.map(file => [file.path.toLowerCase(), file.path]));
  const currentDir = currentPath?.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
  const candidates = new Set<string>();

  if (decodedPath.startsWith('/')) {
    addCandidate(candidates, decodedPath.replace(/^\/+/, ''));
  } else {
    addCandidate(candidates, currentDir ? `${currentDir}/${decodedPath}` : decodedPath);
    addCandidate(candidates, decodedPath);
  }

  for (const candidate of candidates) {
    const existingPath = fileByLowerPath.get(candidate.toLowerCase());
    if (existingPath) return existingPath;
  }

  return null;
}

function getInternalHrefPath(href: string) {
  if (!/^[a-z][a-z\d+.-]*:/i.test(href)) return href;

  try {
    const url = new URL(href, window.location.origin);
    const isCurrentOrigin = url.origin === window.location.origin;
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return isCurrentOrigin || isLocalhost ? url.pathname : null;
  } catch {
    return null;
  }
}

function addCandidate(candidates: Set<string>, pathToAdd: string) {
  const normalized = normalizeRepoPath(pathToAdd);
  if (normalized) candidates.add(normalized);
}

function normalizeRepoPath(filePath: string) {
  const parts: string[] = [];

  for (const part of filePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join('/');
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default HelpDocsModal;
