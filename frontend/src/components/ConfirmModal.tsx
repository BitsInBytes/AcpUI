import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger'
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1100 }}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="modal-content"
            style={{ maxWidth: '400px' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <div className="modal-title">
                <AlertTriangle size={18} className={variant === 'danger' ? 'danger-icon' : ''} />
                <h2>{title}</h2>
              </div>
              <button className="close-btn" onClick={onClose}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                {message}
              </p>
            </div>

            <div className="modal-footer" style={{ gap: '0.75rem' }}>
              <button className="cancel-delete-btn" onClick={onClose}>
                {cancelText}
              </button>
              <button 
                className={variant === 'danger' ? 'confirm-delete-btn' : 'done-button'} 
                onClick={() => {
                  onConfirm();
                  onClose();
                }}
              >
                {confirmText}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default ConfirmModal;
