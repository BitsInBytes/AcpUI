import React from 'react';
import { Archive, X, Trash2 } from 'lucide-react';

interface ArchiveModalProps {
  archives: string[];
  archiveSearch: string;
  setArchiveSearch: (value: string) => void;
  onRestore: (folderName: string) => void;
  onDelete: (folderName: string) => void;
  restoring: string | null;
  onClose: () => void;
}

const ArchiveModal: React.FC<ArchiveModalProps> = ({ archives, archiveSearch, setArchiveSearch, onRestore, onDelete, restoring, onClose }) => {
  const filtered = archiveSearch
    ? archives.filter(a => a.toLowerCase().includes(archiveSearch.toLowerCase()))
    : archives;

  return (
    <div className="archive-modal-overlay" onClick={onClose}>
      <div className="archive-modal" onClick={e => e.stopPropagation()}>
        <div className="archive-modal-header">
          <h3>Archived Chats</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="archive-list">
          <div className="search-wrapper">
            <input
              type="text"
              placeholder="Search archives..."
              value={archiveSearch}
              onChange={e => setArchiveSearch(e.target.value)}
              className="archive-search-input"
            />
            {archiveSearch && <button className="search-clear" onClick={() => setArchiveSearch('')}><X size={14} /></button>}
          </div>
          {filtered.length === 0 ? (
            <p className="archive-empty">No archived chats found.</p>
          ) : filtered.map(name => (
            <div key={name} className="archive-item">
              <div className="archive-item-info" onClick={() => onRestore(name)}>
                <Archive size={14} />
                <span>{name}</span>
                {restoring === name && <span className="restoring">Restoring...</span>}
              </div>
              <button className="archive-delete-btn" onClick={(e) => { e.stopPropagation(); onDelete(name); }} title="Delete archive">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ArchiveModal;
