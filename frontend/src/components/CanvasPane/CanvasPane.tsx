import { useState, useEffect, useRef, useCallback } from 'react';
import { FileCode, TerminalSquare, X, HardDrive, Check, Eye, Code, ExternalLink, GitCompareArrows, GitBranch, FilePlus, FileEdit, FileX, FileQuestion, RefreshCw } from 'lucide-react';
import Editor, { loader } from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './CanvasPane.css';
import type { CanvasArtifact } from '../../types';
import { useSocket } from '../../hooks/useSocket';
import { useCanvasStore } from '../../store/useCanvasStore';
import { useSessionLifecycleStore } from '../../store/useSessionLifecycleStore';
import { useSystemStore } from '../../store/useSystemStore';
import Terminal from '../Terminal';
import { clearSpawnedTerminal } from '../../utils/terminalState';
import { isFileChanged as isFileChangedHelper, buildFullPath } from '../../utils/canvasHelpers';

interface CanvasPaneProps {
  artifacts: CanvasArtifact[];
  activeArtifact: CanvasArtifact | null;
  onSelectArtifact: (artifact: CanvasArtifact) => void;
  onCloseArtifact: (artifactId: string) => void;
  onClose: () => void;
}

const getMonacoLanguage = (language: string, filePath?: string): string => {
  const lang = language.toLowerCase();
  
  // Mapping for common languages
  if (['js', 'javascript'].includes(lang)) return 'javascript';
  if (['ts', 'typescript', 'tsx'].includes(lang)) return 'typescript';
  if (['cs', 'csharp'].includes(lang)) return 'csharp';
  if (['py', 'python'].includes(lang)) return 'python';
  if (['md', 'markdown'].includes(lang)) return 'markdown';
  if (['html'].includes(lang)) return 'html';
  if (['css'].includes(lang)) return 'css';
  if (['json'].includes(lang)) return 'json';
  if (['sql'].includes(lang)) return 'sql';
  if (['xml'].includes(lang)) return 'xml';
  if (['yaml', 'yml'].includes(lang)) return 'yaml';
  
  // Try to infer from filePath extension if language is generic
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'tsx' || ext === 'ts') return 'typescript';
    if (ext === 'cs') return 'csharp';
    if (ext === 'py') return 'python';
    if (ext === 'json') return 'json';
    if (ext === 'md') return 'markdown';
  }

  return 'plaintext';
};

function SafeDiffEditor({ language, original, modified, fileKey }: { language: string; original: string; modified: string; fileKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    loader.init().then((monaco) => {
        if (disposed || !containerRef.current) return;

        const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
          readOnly: true,
          minimap: { enabled: false },
          fontSize: 14,
          wordWrap: 'on',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          renderSideBySide: true,
          padding: { top: 16, bottom: 16 },
          theme: 'vs-dark',
        });

        const uid = `${fileKey}-${Date.now()}`;
        const originalModel = monaco.editor.createModel(original, language, monaco.Uri.parse(`diff://original/${uid}`));
        const modifiedModel = monaco.editor.createModel(modified, language, monaco.Uri.parse(`diff://modified/${uid}`));
        diffEditor.setModel({ original: originalModel, modified: modifiedModel });
        editorRef.current = { editor: diffEditor, original: originalModel, modified: modifiedModel };
      });

    return () => {
      disposed = true;
      try {
        editorRef.current?.editor?.dispose();
        editorRef.current?.original?.dispose();
        editorRef.current?.modified?.dispose();
      } catch { /* already disposed */ }
      editorRef.current = null;
    };
  }, [language, original, modified, fileKey]);

  return <div ref={containerRef} style={{ height: '100%', width: '100%' }} />;
}

export default function CanvasPane({ artifacts, activeArtifact, onSelectArtifact, onCloseArtifact, onClose }: CanvasPaneProps) {
  const [content, setContent] = useState(activeArtifact?.content || '');
  const [isApplied, setIsApplied] = useState(false);
  const [viewMode, setViewMode] = useState<'code' | 'preview' | 'diff'>('code');
  const [gitOriginal, setGitOriginal] = useState<string | null>(null);
  const [gitFiles, setGitFiles] = useState<{ path: string; status: string; staged: boolean }[]>([]);
  const [gitBranch, setGitBranch] = useState('');
  const { socket } = useSocket();
  const { terminals, activeTerminalId, closeTerminal, setActiveTerminalId } = useCanvasStore();
  const activeSessionId = useSessionLifecycleStore(state => state.activeSessionId);
  const sessions = useSessionLifecycleStore(state => state.sessions);
  const sessionTerminals = terminals.filter(t => t.sessionId === activeSessionId);
  const cwd = sessions.find(s => s.id === activeSessionId)?.cwd || useSystemStore.getState().workspaceCwds[0]?.path || '';

  const isMarkdown = activeArtifact && (
    activeArtifact.language.toLowerCase() === 'markdown' || 
    activeArtifact.language.toLowerCase() === 'md' ||
    activeArtifact.filePath?.toLowerCase().endsWith('.md')
  );

  const prevArtifactIdRef = useRef<string | null>(null);
  const gitOpenRef = useRef(false);

  useEffect(() => {
    if (activeArtifact) {
      setContent(activeArtifact.content);
      setIsApplied(false);
      
      if (prevArtifactIdRef.current !== activeArtifact.id) {
        if (!gitOpenRef.current) {
          setGitOriginal(null);
          if (isMarkdown) {
            setViewMode('preview');
          } else {
            setViewMode('code');
          }
        }
        gitOpenRef.current = false;
      }
      prevArtifactIdRef.current = activeArtifact.id;
    }
  }, [activeArtifact, isMarkdown]);

  // Fetch git status for the workspace
  const refreshGitStatus = useCallback(() => {
    if (!socket || !cwd) return;
    socket.emit('git_status', { cwd }, (res: { branch?: string; files?: { path: string; status: string; staged: boolean }[] }) => {
      setGitBranch(res.branch || '');
      setGitFiles(res.files || []);
    });
  }, [socket, cwd]);

  useEffect(() => { refreshGitStatus(); }, [refreshGitStatus]);
  // Refresh when artifacts update (file was edited)
  useEffect(() => { refreshGitStatus(); }, [artifacts, refreshGitStatus]);

  const fileChanged = isFileChangedHelper(activeArtifact?.filePath, gitFiles);

  const handleOpenGitFile = (filePath: string) => {
    if (!socket || !activeSessionId) return;
    const fullPath = buildFullPath(cwd, filePath);
    socket.emit('canvas_read_file', { filePath: fullPath }, (res: { artifact?: CanvasArtifact }) => {
      if (res.artifact) {
        const artifactId = res.artifact.id;
        gitOpenRef.current = true;
        useCanvasStore.getState().handleOpenInCanvas(socket, activeSessionId, res.artifact);
        setActiveTerminalId(null);
        // Set content and null out gitOriginal immediately — the guard in the render
        // (gitOriginal !== null) prevents SafeDiffEditor from mounting until data arrives
        setContent(res.artifact.content);
        setGitOriginal(null);
        setViewMode('diff');
        socket.emit('git_show_head', { cwd, filePath: fullPath }, (headRes: { content: string }) => {
          const current = useCanvasStore.getState().activeCanvasArtifact;
          if (current?.id !== artifactId && current?.filePath !== fullPath) return;
          setGitOriginal(headRes.content);
        });
      }
    });
  };

  const handleApplyToFile = () => {
    if (socket && activeArtifact?.filePath) {
      socket.emit('canvas_apply_to_file', { filePath: activeArtifact.filePath, content }, (res: { success?: boolean; error?: string }) => {
        if (res.success) {
          setIsApplied(true);
          setTimeout(() => setIsApplied(false), 2000);
        } else if (res.error) {
          alert('Failed to apply changes: ' + res.error);
        }
      });
    }
  };

  return (
    <div className="canvas-pane-container">
      {/* Main Editor Area */}
      <div className="canvas-main">
        {/* Horizontal File List Tabs */}
        <div className="canvas-file-tabs">
          {sessionTerminals.map(t => (
            <div
              key={t.id}
              className={`canvas-file-tab terminal-tab ${activeTerminalId === t.id ? 'active' : ''}`}
              onClick={() => setActiveTerminalId(t.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); socket?.emit('terminal_kill', { terminalId: t.id }); clearSpawnedTerminal(t.id); closeTerminal(t.id); } }}
              title={t.label}
            >
              <TerminalSquare size={14} className="file-icon" />
              <span className="file-name">{t.label}</span>
              <button
                className="canvas-tab-close"
                onClick={(e) => { e.stopPropagation(); socket?.emit('terminal_kill', { terminalId: t.id }); clearSpawnedTerminal(t.id); closeTerminal(t.id); }}
                title="Close terminal"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {artifacts.map((art) => {
             
            const isGlowing = art.lastUpdated && (Date.now() - art.lastUpdated < 3000);
            return (
              <div 
                key={art.id} 
                className={`canvas-file-tab ${activeArtifact?.id === art.id ? 'active' : ''} ${isGlowing ? 'glow' : ''}`}
                onClick={() => { onSelectArtifact(art); setActiveTerminalId(null); }}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseArtifact(art.id); } }}
                title={art.filePath || art.title}
              >
                <FileCode size={14} className="file-icon" />
                <span className="file-name">{(art.filePath || art.title).split(/[/\\]/).pop()}</span>
                <button 
                  className="canvas-tab-close" 
                  onClick={(e) => { e.stopPropagation(); onCloseArtifact(art.id); }}
                  title="Close file"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          {artifacts.length === 0 && !sessionTerminals.length && (
            <div className="canvas-empty-tabs">No files being watched.</div>
          )}
        </div>

        {gitFiles.length > 0 && (
          <div className="canvas-git-panel">
            <div className="canvas-git-header">
              <GitBranch size={12} />
              <span>{gitBranch}</span>
              <span className="canvas-git-count">{gitFiles.length}</span>
              <button className="canvas-git-refresh" onClick={refreshGitStatus} title="Refresh"><RefreshCw size={10} /></button>
            </div>
            <div className="canvas-git-files">
              {gitFiles.map(f => (
                <div key={f.path} className="canvas-git-file" onClick={() => handleOpenGitFile(f.path)} title={f.path}>
                  {f.status === 'added' ? <FilePlus size={12} className="git-added" /> :
                   f.status === 'deleted' ? <FileX size={12} className="git-deleted" /> :
                   f.status === 'untracked' ? <FileQuestion size={12} className="git-untracked" /> :
                   <FileEdit size={12} className="git-modified" />}
                  <span>{f.path.split(/[/\\]/).pop()}</span>
                  {f.staged && <span className="canvas-git-staged">S</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTerminalId ? (
          <div className="canvas-terminal-content">
            {sessionTerminals.map(t => (
              <Terminal key={t.id} socket={socket} cwd={cwd} terminalId={t.id} visible={activeTerminalId === t.id} onExit={() => { clearSpawnedTerminal(t.id); closeTerminal(t.id); }} />
            ))}
          </div>
        ) : !activeArtifact ? (
          <div className="canvas-placeholder">Select a file to view or edit.</div>
        ) : (
          <>
            <div className="canvas-toolbar">
              <div className="canvas-title">
                {activeArtifact.filePath || activeArtifact.title} 
                <span className="canvas-language">{activeArtifact.language}</span>
              </div>
              <div className="canvas-actions">
                {isMarkdown && (
                  <button 
                    onClick={() => setViewMode(viewMode === 'code' ? 'preview' : 'code')} 
                    className="canvas-btn"
                    title={viewMode === 'code' ? "Switch to Preview" : "Switch to Code"}
                  >
                    {viewMode === 'code' ? <><Eye size={14} /> Preview</> : <><Code size={14} /> Code</>}
                  </button>
                )}
                {activeArtifact.filePath && fileChanged && (
                  <button
                    onClick={() => {
                      if (viewMode === 'diff') { setViewMode('code'); return; }
                      if (!socket || !cwd || !activeArtifact.filePath) return;
                      socket.emit('git_show_head', { cwd, filePath: activeArtifact.filePath }, (res: { content: string }) => {
                        setGitOriginal(res.content);
                        setViewMode('diff');
                      });
                    }}
                    className={`canvas-btn ${viewMode === 'diff' ? 'active' : ''}`}
                    title={viewMode === 'diff' ? "Switch to Editor" : "Show Git Diff"}
                  >
                    <GitCompareArrows size={14} /> Diff
                  </button>
                )}
                {activeArtifact.filePath && (
                  <button 
                    onClick={handleApplyToFile} 
                    className={`canvas-btn primary ${isApplied ? 'applied' : ''}`} 
                    title="Write to disk"
                    disabled={isApplied}
                  >
                    {isApplied ? (
                      <><Check size={14} /> Applied!</>
                    ) : (
                      <><HardDrive size={14} /> Apply</>
                    )}
                  </button>
                )}
                {activeArtifact.filePath && (
                  <button
                    onClick={() => socket?.emit('open_in_editor', { filePath: activeArtifact.filePath })}
                    className="canvas-btn"
                    title="Open in VS Code"
                  >
                    <ExternalLink size={14} /> VS Code
                  </button>
                )}
                <button onClick={onClose} className="canvas-btn close">
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="canvas-content-area">
               {viewMode === 'diff' && gitOriginal !== null ? (
                 <SafeDiffEditor
                   key={activeArtifact.id}
                   fileKey={activeArtifact.id}
                   language={getMonacoLanguage(activeArtifact.language, activeArtifact.filePath)}
                   original={gitOriginal}
                   modified={content}
                 />
               ) : viewMode === 'code' ? (
                 <Editor
                    height="100%"
                    defaultLanguage={getMonacoLanguage(activeArtifact.language, activeArtifact.filePath)}
                    language={getMonacoLanguage(activeArtifact.language, activeArtifact.filePath)}
                    theme="vs-dark"
                    value={content}
                    onChange={(value) => setContent(value || '')}
                    onMount={(_editor, monaco) => {
                      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
                      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
                    }}
                    options={{
                      minimap: { enabled: true },
                      fontSize: 14,
                      wordWrap: 'on',
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                      renderLineHighlight: 'none',
                      padding: { top: 16, bottom: 16 }
                    }}
                  />
               ) : (
                 <div className="canvas-markdown-preview markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {content}
                    </ReactMarkdown>
                 </div>
               )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
