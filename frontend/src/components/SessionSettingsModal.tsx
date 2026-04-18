import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Settings, Database, Activity, HardDrive, Cpu, AlertTriangle, Trash2, RefreshCw } from 'lucide-react';
import './SessionSettingsModal.css';
import { useUIStore, type SettingsTab } from '../store/useUIStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { getFullModelChoices, getFullModelSelectionValue } from '../utils/modelOptions';

const ContextUsageCard: React.FC<{ acpSessionId: string | null | undefined }> = ({ acpSessionId }) => {
  const pct = useSystemStore(state => acpSessionId ? state.contextUsageBySession[acpSessionId] : undefined);
  const rounded = pct !== undefined ? Math.round(pct) : 0;
  return (
    <div className="stat-card context-card">
      <div className="stat-card-header">
        <Cpu size={14} />
        <span>Context Window</span>
      </div>
      <div className="progress-bar-bg">
        <div className={`progress-bar-fill ${rounded > 80 ? 'danger' : ''}`} style={{ width: `${rounded}%` }} />
      </div>
      <div className="stat-card-footer">
        <span>{pct !== undefined ? `${pct.toFixed(1)}% of context used` : 'No data yet'}</span>
      </div>
    </div>
  );
};

const SessionSettingsModal: React.FC = () => {
  const { socket } = useSystemStore();
  const { isSettingsOpen: isOpen, settingsSessionId, settingsInitialTab, setSettingsOpen } = useUIStore();
  const {
    sessions,
    handleDeleteSession,
    handleSessionModelChange,
    handleSetSessionOption
  } = useSessionLifecycleStore();

  const session = sessions.find(s => s.id === settingsSessionId);

  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('session');
  const [rehydrateStatus, setRehydrateStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [rehydrateMsg, setRehydrateMsg] = useState('');
  const [exportPath, setExportPath] = useState('');
  const [exportStatus, setExportStatus] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [exportMsg, setExportMsg] = useState('');

  const handleRehydrate = () => {
    if (!session?.acpSessionId || !socket) return;
    setRehydrateStatus('loading');
    socket.emit('rehydrate_session', { uiId: session.id }, (res: { success?: boolean; messageCount?: number; error?: string }) => {
      if (res.success) {
        setRehydrateStatus('done');
        setRehydrateMsg(`Rebuilt ${res.messageCount} messages from JSONL`);
        // Reload messages into UI
        socket.emit('get_session_history', { uiId: session.id }, (histRes: { session?: { messages: unknown[] } }) => {
          if (histRes?.session) {
            useSessionLifecycleStore.setState(state => ({
              sessions: state.sessions.map(s => s.id === session.id
                ? { ...s, messages: histRes.session!.messages as typeof s.messages }
                : s)
            }));
          }
        });
      } else {
        setRehydrateStatus('error');
        setRehydrateMsg(res.error || 'Failed to rehydrate');
      }
    });
  };

  const onClose = () => setSettingsOpen(false);


  const handleDelete = () => {
    if (!session) return;
    handleDeleteSession(socket, session.id);
    onClose();
  };


  useEffect(() => {
    if (isOpen) {
      setShowConfirmDelete(false);
      setActiveTab(settingsInitialTab);
      setRehydrateStatus('idle');
      setRehydrateMsg('');
    }
  }, [isOpen, settingsInitialTab]);

  if (!session) return null;

  const brandingModels = useSystemStore.getState().branding.models;
  const modelChoices = getFullModelChoices(session, brandingModels);
  const selectedModelValue = getFullModelSelectionValue(session, brandingModels);


  return (
    <AnimatePresence>
      {isOpen && (
        <div className="modal-overlay" onClick={onClose}>
          <motion.div
            layout
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="modal-content"
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <div className="modal-title">
                <Settings size={18} />
                <h2>Session Settings</h2>
              </div>
              <button className="close-btn" onClick={onClose}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-tabs">
              <button className={`tab-btn ${activeTab === 'session' ? 'active' : ''}`} onClick={() => setActiveTab('session')}>Info</button>
              <button className={`tab-btn ${activeTab === 'config' ? 'active' : ''}`} onClick={() => setActiveTab('config')}>Config</button>
              <button className={`tab-btn ${activeTab === 'rehydrate' ? 'active' : ''}`} onClick={() => setActiveTab('rehydrate')}>Rehydrate</button>
              <button className={`tab-btn ${activeTab === 'export' ? 'active' : ''}`} onClick={() => setActiveTab('export')}>Export</button>
              <button className={`tab-btn danger-tab ${activeTab === 'danger' ? 'active' : ''}`} onClick={() => setActiveTab('danger')}>Delete</button>
            </div>

            <div className="modal-body">
              {activeTab === 'session' && (
                <div className="settings-container">
                  <div className="settings-section">
                    <div className="section-header">
                      <HardDrive size={16} />
                      <h3>System Discovery</h3>
                    </div>
                    <div className="system-info-grid">
                      <div className="system-info-item">
                        <span className="info-label">ACP Session ID</span>
                        <span className="info-value code">{session.acpSessionId || 'Not initialized'}</span>
                      </div>
                      <div className="system-info-item">
                        <span className="info-label">{useSystemStore.getState().branding.sessionLabel}</span>
                        <span className="info-value code">ACP ID: {session.acpSessionId || '...'}</span>
                      </div>
                      <div className="system-info-item">
                        <span className="info-label">Attachments</span>
                        <span className="info-value code">UI ID: {session.id}</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <div className="section-header">
                      <Activity size={16} />
                      <h3>Context Usage</h3>
                    </div>

                    <div className="stats-container">
                      <div className="structured-stats">
                        <ContextUsageCard acpSessionId={session.acpSessionId} />
                      </div>
                    </div>
                  </div>
                </div>
              )}


              {activeTab === 'config' && (
                <>
                <div className="settings-section">
                  <div className="section-header">
                    <Database size={16} />
                    <h3>Model Selection</h3>
                  </div>
                  <p className="section-desc">Select which {useSystemStore.getState().branding.modelLabel} to use for this session.</p>

                  <div className="model-selector">
                    <select
                      value={selectedModelValue}
                      onChange={(e) => handleSessionModelChange(socket, session.id, e.target.value)}
                      className="model-select"
                    >
                      {modelChoices.map(choice => (
                        <option key={choice.id} value={choice.selection} title={choice.description}>
                          {choice.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {session.configOptions && session.configOptions.length > 0 && (
                  <div className="settings-section">
                    <div className="section-header">
                      <Settings size={16} />
                      <h3>Provider Settings</h3>
                    </div>
                    <p className="section-desc">Dynamic settings provided by the ACP daemon.</p>

                    <div className="provider-options-grid">
                      {session.configOptions.map(opt => (
                        <div key={opt.id} className="provider-option-item">
                          <div className="option-info">
                            <span className="option-name">{opt.name}</span>
                            {opt.description && <p className="option-desc">{opt.description}</p>}
                          </div>

                          <div className="option-control">
                            {opt.type === 'select' && opt.options && (
                              <select
                                value={String(opt.currentValue ?? '')}
                                onChange={(e) => handleSetSessionOption(socket, session.id, opt.id, e.target.value)}
                                className="model-select"
                              >
                                {opt.options.map(o => (
                                  <option key={o.value} value={o.value} title={o.description}>{o.name}</option>
                                ))}
                              </select>
                            )}
                            {opt.type === 'boolean' && (
                              <button
                                className={`toggle-btn ${opt.currentValue ? 'active' : ''}`}
                                onClick={() => handleSetSessionOption(socket, session.id, opt.id, !opt.currentValue)}
                              >
                                {opt.currentValue ? 'Enabled' : 'Disabled'}
                              </button>
                            )}
                            {opt.type === 'number' && (
                              <input
                                type="number"
                                value={Number(opt.currentValue ?? 0)}
                                onChange={(e) => handleSetSessionOption(socket, session.id, opt.id, Number(e.target.value))}
                                className="model-select"
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                </>
              )}

              {activeTab === 'rehydrate' && (
                <div className="settings-section">
                  <div className="section-header">
                    <RefreshCw size={16} />
                    <h3>Rehydrate from JSONL</h3>
                  </div>
                  <p className="section-desc">Force rebuild the chat history from the raw JSONL session file. This replaces the current DB record and UI state.</p>

                  {rehydrateStatus === 'idle' && (
                    <button className="rehydrate-btn" onClick={handleRehydrate} disabled={!session.acpSessionId}>
                      <RefreshCw size={14} />
                      Rebuild from JSONL
                    </button>
                  )}
                  {rehydrateStatus === 'loading' && (
                    <div className="rehydrate-status">
                      <RefreshCw size={14} className="spinning" />
                      <span>Parsing JSONL...</span>
                    </div>
                  )}
                  {rehydrateStatus === 'done' && (
                    <div className="rehydrate-status success">
                      <span>✓ {rehydrateMsg}</span>
                    </div>
                  )}
                  {rehydrateStatus === 'error' && (
                    <div className="rehydrate-status error">
                      <span>✗ {rehydrateMsg}</span>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'export' && (
                <div className="settings-section">
                  <div className="section-header">
                    <HardDrive size={16} />
                    <h3>Export Session</h3>
                  </div>
                  <p className="section-desc">Export this session's data (messages, JSONL, attachments) to a folder.</p>
                  <div className="env-row" style={{ marginTop: '0.5rem' }}>
                    <label className="env-key">Export to</label>
                    <input
                      className="env-value"
                      value={exportPath}
                      onChange={e => { setExportPath(e.target.value); setExportStatus('idle'); }}
                      placeholder="C:\Users\you\Desktop\exports"
                    />
                  </div>
                  <button
                    className="done-button"
                    style={{ marginTop: '0.5rem' }}
                    disabled={!exportPath.trim() || exportStatus === 'exporting'}
                    onClick={() => {
                      if (!socket || !session) return;
                      setExportStatus('exporting');
                      socket.emit('export_session', { uiId: session.id, exportPath: exportPath.trim() }, (res: { success?: boolean; exportDir?: string; error?: string }) => {
                        if (res?.success) { setExportStatus('done'); setExportMsg(`Exported to ${res.exportDir}`); }
                        else { setExportStatus('error'); setExportMsg(res?.error || 'Export failed'); }
                      });
                    }}
                  >
                    {exportStatus === 'exporting' ? 'Exporting...' : 'Export'}
                  </button>
                  {exportStatus === 'done' && <p className="ws-saved">✓ {exportMsg}</p>}
                  {exportStatus === 'error' && <p className="ws-error">{exportMsg}</p>}
                </div>
              )}

              {activeTab === 'danger' && (
                <div className="settings-section danger-zone">
                  <div className="section-header">
                    <AlertTriangle size={16} className="danger-icon" />
                    <h3>Danger Zone</h3>
                  </div>
                  <p className="section-desc">Permanently delete this chat and all its history from the database and local filesystem.</p>

                  {!showConfirmDelete ? (
                    <button className="delete-chat-btn" onClick={() => setShowConfirmDelete(true)}>
                      <Trash2 size={14} />
                      Delete Chat
                    </button>
                  ) : (
                    <div className="confirm-delete-actions">
                      <span className="confirm-text">Are you sure?</span>
                      <button className="confirm-delete-btn" onClick={handleDelete}>Yes, Delete</button>
                      <button className="cancel-delete-btn" onClick={() => setShowConfirmDelete(false)}>Cancel</button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="done-button" onClick={onClose}>Done</button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default SessionSettingsModal;
