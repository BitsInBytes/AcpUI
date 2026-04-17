import React, { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { WorkspaceCwd } from '../types';
import { useSystemStore } from '../store/useSystemStore';

interface WorkspacePickerModalProps {
  workspaces: WorkspaceCwd[];
  onSelect: (workspace: WorkspaceCwd) => void;
  onClose: () => void;
}

const WorkspacePickerModal: React.FC<WorkspacePickerModalProps> = ({ workspaces, onSelect, onClose }) => {
  const [search, setSearch] = useState('');
  const filtered = search
    ? workspaces.filter(w => w.label.toLowerCase().includes(search.toLowerCase()) || w.path.toLowerCase().includes(search.toLowerCase()))
    : workspaces;

  return (
    <div className="archive-modal-overlay" onClick={onClose}>
      <div className="archive-modal workspace-picker" onClick={e => e.stopPropagation()}>
        <div className="archive-modal-header">
          <h3>Open Workspace</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="archive-list">
          <div className="search-wrapper">
            <input
              type="text"
              placeholder="Search workspaces..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="archive-search-input"
              autoFocus
            />
            {search && <button className="search-clear" onClick={() => setSearch('')}><X size={14} /></button>}
          </div>
          {filtered.length === 0 ? (
            <p className="archive-empty">No workspaces found.</p>
          ) : filtered.map(w => (
            <div key={w.path} className="archive-item workspace-item" onClick={() => { onSelect(w); onClose(); }}>
              <div className="archive-item-info">
                <FolderOpen size={14} />
                <span className="workspace-label">{w.label}</span>
                <div className="workspace-path">{w.path}</div>
                </div>
                {useSystemStore.getState().branding.supportsAgentSwitching && w.agent && <span className="workspace-agent">{w.agent}</span>}
                </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WorkspacePickerModal;
