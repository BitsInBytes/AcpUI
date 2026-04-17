import React from 'react';
import { X, FileCode, FileImage, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Attachment } from '../types';
import './FileTray.css';

interface FileTrayProps {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}

const FileTray: React.FC<FileTrayProps> = ({ attachments, onRemove }) => {
  const getIcon = (mime: string) => {
    if (mime.startsWith('image/')) return <FileImage size={14} />;
    if (mime.includes('javascript') || mime.includes('typescript') || mime.includes('json') || mime.includes('sql')) return <FileCode size={14} />;
    return <FileText size={14} />;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (attachments.length === 0) return null;

  return (
    <div className="file-chips-wrapper">
      <AnimatePresence>
        {attachments.map((file, idx) => (
          <motion.div 
            key={`${file.name}-${idx}`}
            initial={{ opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 10 }}
            className="file-chip"
          >
            <span className="file-chip-icon">{getIcon(file.mimeType || '')}</span> 
            <div className="file-chip-info">
              <span className="file-chip-name">{file.name}</span>
              <span className="file-chip-size">{formatSize(file.size)}</span>
            </div>
            <button className="file-chip-remove" onClick={() => onRemove(idx)}>
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};

export default FileTray;
