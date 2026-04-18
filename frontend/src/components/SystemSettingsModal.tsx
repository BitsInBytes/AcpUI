import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Settings, Mic, RefreshCw, FileText, FolderCog, Terminal } from 'lucide-react';
import Editor from '@monaco-editor/react';
import { useSystemStore } from '../store/useSystemStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { useUIStore } from '../store/useUIStore';
import './SessionSettingsModal.css';

const SystemSettingsModal: React.FC = () => {
  const { socket } = useSystemStore();
  const expandedProviderId = useUIStore(state => state.expandedProviderId);
  const systemProviderId = useSystemStore(state => state.activeProviderId || state.defaultProviderId);
  const providerId = expandedProviderId || systemProviderId;
  const isOpen = useUIStore(state => state.isSystemSettingsOpen);
  const setOpen = useUIStore(state => state.setSystemSettingsOpen);
  const { availableAudioDevices, selectedAudioDevice, setSelectedAudioDevice, fetchAudioDevices } = useVoiceStore();

  const [activeTab, setActiveTab] = useState<'audio' | 'env' | 'workspaces' | 'commands' | 'provider'>('audio');
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [envLoading, setEnvLoading] = useState(false);
  const [wsConfig, setWsConfig] = useState('');
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsSaved, setWsSaved] = useState(false);
  const [cmdConfig, setCmdConfig] = useState('');
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [cmdSaved, setCmdSaved] = useState(false);
  const [userConfig, setUserConfig] = useState('');
  const [userError, setUserError] = useState<string | null>(null);
  const [userSaved, setUserSaved] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isOpen) {
      setActiveTab('audio');
      if (socket) {
        setEnvLoading(true);
        socket.emit('get_env', (res: { vars?: Record<string, string> }) => {
          if (res.vars) setEnvVars(res.vars);
          setEnvLoading(false);
        });
        socket.emit('get_workspaces_config', (res: { content: string }) => {
          try { setWsConfig(JSON.stringify(JSON.parse(res.content), null, 2)); }
          catch { setWsConfig(res.content); }
          setWsError(null);
          setWsSaved(false);
        });
        socket.emit('get_commands_config', (res: { content: string }) => {
          try { setCmdConfig(JSON.stringify(JSON.parse(res.content), null, 2)); }
          catch { setCmdConfig(res.content); }
          setCmdError(null);
          setCmdSaved(false);
        });
        const handleProviderConfig = (res: { content: string }) => {
          try { setUserConfig(JSON.stringify(JSON.parse(res.content), null, 2)); }
          catch { setUserConfig(res.content); }
          setUserError(null);
          setUserSaved(false);
        };
        if (providerId) socket.emit('get_provider_config', { providerId }, handleProviderConfig);
        else socket.emit('get_provider_config', handleProviderConfig);
      }
    }
  }, [isOpen, socket, providerId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const updateEnv = (key: string, value: string) => {
    setEnvVars(prev => ({ ...prev, [key]: value }));
    socket?.emit('update_env', { key, value });
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="modal-overlay" onClick={() => setOpen(false)}>
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.2 }}
          className="modal-content system-settings-modal"
          onClick={e => e.stopPropagation()}
        >
          <div className="modal-header">
            <div className="modal-title">
              <Settings size={18} />
              <h2>System Settings</h2>
            </div>
            <button className="close-btn" onClick={() => setOpen(false)}>
              <X size={20} />
            </button>
          </div>

          <div className="modal-tabs">
            <button className={`tab-btn ${activeTab === 'audio' ? 'active' : ''}`} onClick={() => setActiveTab('audio')}>Audio</button>
            <button className={`tab-btn ${activeTab === 'env' ? 'active' : ''}`} onClick={() => setActiveTab('env')}>Environment</button>
            <button className={`tab-btn ${activeTab === 'workspaces' ? 'active' : ''}`} onClick={() => setActiveTab('workspaces')}>Workspaces</button>
            <button className={`tab-btn ${activeTab === 'commands' ? 'active' : ''}`} onClick={() => setActiveTab('commands')}>Commands</button>
            <button className={`tab-btn ${activeTab === 'provider' ? 'active' : ''}`} onClick={() => setActiveTab('provider')}>Provider</button>
          </div>

          <div className="modal-body">
            {activeTab === 'audio' && (
              <div className="settings-section">
                <div className="section-header">
                  <Mic size={16} />
                  <h3>Audio Input</h3>
                  <button className="refresh-stats-btn" onClick={fetchAudioDevices} title="Refresh Devices">
                    <RefreshCw size={12} />
                  </button>
                </div>
                <p className="section-desc">Select the microphone for voice-to-text input.</p>
                <div className="model-selector">
                  <select
                    value={selectedAudioDevice}
                    onChange={(e) => setSelectedAudioDevice(e.target.value)}
                    className="model-select"
                  >
                    <option value="">Default System Device</option>
                    {availableAudioDevices.map(device => (
                      <option key={device.id} value={device.id}>{device.label || `Microphone ${device.id.substring(0, 5)}`}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {activeTab === 'env' && (
              <div className="settings-section">
                <div className="section-header">
                  <FileText size={16} />
                  <h3>Environment Variables</h3>
                </div>
                <p className="section-desc">Edit .env configuration. Changes take effect on next backend restart unless noted.</p>
                {envLoading ? (
                  <div className="stats-loading">Loading...</div>
                ) : (
                  <div className="env-grid">
                    {Object.entries(envVars)
                      .sort(([keyA, valA], [keyB, valB]) => {
                        // Logic: Booleans first, then alphabetize by key
                        const isBoolA = valA === 'true' || valA === 'false';
                        const isBoolB = valB === 'true' || valB === 'false';
                        if (isBoolA && !isBoolB) return -1;
                        if (!isBoolA && isBoolB) return 1;
                        return keyA.localeCompare(keyB);
                      })
                      .map(([key, value]) => {
                      const isBool = value === 'true' || value === 'false';
                      return (
                        <div key={key} className={`env-row ${isBool ? 'env-row-toggle' : ''}`}>
                          <label className="env-key" title={key}>{key.replace(/_/g, ' ')}</label>
                          {isBool ? (
                            <button
                              className={`env-toggle ${value === 'true' ? 'on' : ''}`}
                              onClick={() => updateEnv(key, value === 'true' ? 'false' : 'true')}
                            >
                              <span className="env-toggle-knob" />
                            </button>
                          ) : (
                            <input
                              className="env-value"
                              value={value}
                              onChange={(e) => setEnvVars(prev => ({ ...prev, [key]: e.target.value }))}
                              onBlur={(e) => updateEnv(key, e.target.value)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'workspaces' && (
              <div className="settings-section">
                <div className="section-header">
                  <FolderCog size={16} />
                  <h3>Workspace Configuration</h3>
                </div>
                <p className="section-desc">Edit workspaces.json. Pinned workspaces appear as sidebar buttons. Changes take effect on restart.</p>
                <div style={{ height: 500, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6 }}>
                  <Editor
                    value={wsConfig}
                    language="json"
                    theme="vs-dark"
                    onChange={(val) => { setWsConfig(val || ''); setWsSaved(false); setWsError(null); }}
                    options={{ minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', automaticLayout: true }}
                  />
                </div>
                {wsError && <p className="ws-error">{wsError}</p>}
                {wsSaved && <p className="ws-saved">✓ Saved</p>}
                <button
                  className="done-button"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => {
                    try {
                      JSON.parse(wsConfig);
                      socket?.emit('save_workspaces_config', { content: wsConfig }, (res: { error?: string }) => {
                        if (res?.error) setWsError(res.error);
                        else setWsSaved(true);
                      });
                    } catch { setWsError('Invalid JSON'); }
                  }}
                >
                  Save
                </button>
              </div>
            )}

            {activeTab === 'commands' && (
              <div className="settings-section">
                <div className="section-header">
                  <Terminal size={16} />
                  <h3>Custom Commands</h3>
                </div>
                <p className="section-desc">Edit commands.json. Custom slash commands with prompts. Changes take effect on restart.</p>
                <div style={{ height: 500, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6 }}>
                  <Editor
                    value={cmdConfig}
                    language="json"
                    theme="vs-dark"
                    onChange={(val) => { setCmdConfig(val || ''); setCmdSaved(false); setCmdError(null); }}
                    options={{ minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', automaticLayout: true }}
                  />
                </div>
                {cmdError && <p className="ws-error">{cmdError}</p>}
                {cmdSaved && <p className="ws-saved">✓ Saved</p>}
                <button
                  className="done-button"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => {
                    try {
                      JSON.parse(cmdConfig);
                      socket?.emit('save_commands_config', { content: cmdConfig }, (res: { error?: string }) => {
                        if (res?.error) setCmdError(res.error);
                        else setCmdSaved(true);
                      });
                    } catch { setCmdError('Invalid JSON'); }
                  }}
                >
                  Save
                </button>
              </div>
            )}

            {activeTab === 'provider' && (
              <div className="settings-section">
                <div className="section-header">
                  <Settings size={16} />
                  <h3>Provider Settings</h3>
                </div>
                <p className="section-desc">Edit user.json. Provider-specific secrets, paths, and overrides. Changes take effect on restart.</p>
                <div style={{ height: 500, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6 }}>
                  <Editor
                    value={userConfig}
                    language="json"
                    theme="vs-dark"
                    onChange={(val) => { setUserConfig(val || ''); setUserSaved(false); setUserError(null); }}
                    options={{ minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', automaticLayout: true }}
                  />
                </div>
                {userError && <p className="ws-error">{userError}</p>}
                {userSaved && <p className="ws-saved">✓ Saved</p>}
                <button
                  className="done-button"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => {
                    try {
                      JSON.parse(userConfig);
                      socket?.emit('save_provider_config', { ...(providerId ? { providerId } : {}), content: userConfig }, (res: { error?: string }) => {
                        if (res?.error) setUserError(res.error);
                        else setUserSaved(true);
                      });
                    } catch { setUserError('Invalid JSON'); }
                  }}
                >
                  Save
                </button>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button className="done-button" onClick={() => setOpen(false)}>Done</button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default SystemSettingsModal;
