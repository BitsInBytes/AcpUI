import React from 'react';
import type { ChatSession } from '../../types';
import { useSystemStore } from '../../store/useSystemStore';
import { Settings } from 'lucide-react';
import './ModelSelector.css';

interface ModelSelectorProps {
  activeSession: ChatSession | undefined;
  isModelDropdownOpen: boolean;
  setIsModelDropdownOpen: (open: boolean) => void;
  onModelSelect: (model: 'fast' | 'balanced' | 'flagship') => void;
  modelDropdownRef: React.RefObject<HTMLDivElement | null>;
  getActiveModelQuotaPercent: () => number | null; // Kept for prop compatibility, but unused visually
  disabled: boolean;
  onOpenSettings?: () => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  activeSession,
  isModelDropdownOpen,
  setIsModelDropdownOpen,
  onModelSelect,
  modelDropdownRef,
  disabled,
  onOpenSettings
}) => {
  const contextPct = useSystemStore(state => activeSession?.acpSessionId ? state.contextUsageBySession[activeSession.acpSessionId] : undefined);
  const isCompacting = useSystemStore(state => activeSession?.acpSessionId ? state.compactingBySession[activeSession.acpSessionId] : false);

  if (!activeSession) return null;

  const getModelName = (modelKey: 'fast' | 'balanced' | 'flagship') => {
    const branding = useSystemStore.getState().branding;
    if (modelKey === 'flagship') return branding.models?.flagship?.displayName || 'Flagship';
    if (modelKey === 'balanced') return branding.models?.balanced?.displayName || 'Balanced';
    if (modelKey === 'fast') return branding.models?.fast?.displayName || 'Fast';
    return 'Model';
  };

  const modelName = getModelName(activeSession.model);
  const label = isCompacting ? `${modelName} (Compacting...)` : contextPct !== undefined ? `${modelName} (${Math.round(contextPct)}%)` : modelName;

  return (
    <div className="model-indicator" ref={modelDropdownRef}>
      {onOpenSettings && (
        <button
          type="button"
          className="model-settings-btn"
          onClick={onOpenSettings}
          title="Open chat config"
          aria-label="Open chat config"
        >
          <Settings size={12} />
        </button>
      )}
      <span>Using </span>
      <button 
        type="button"
        onClick={() => !disabled && setIsModelDropdownOpen(!isModelDropdownOpen)}
        className="model-indicator-btn"
        disabled={disabled}
      >
        {label}
      </button>

      {isModelDropdownOpen && (
        <div className="model-dropdown-menu">
          <button
            type="button"
            className={`model-dropdown-item ${activeSession.model === 'fast' ? 'active' : ''}`}
            onClick={() => { onModelSelect('fast'); setIsModelDropdownOpen(false); }}
          >
            {useSystemStore.getState().branding.models?.fast?.displayName || 'Fast'}
          </button>
          <button
            type="button"
            className={`model-dropdown-item ${activeSession.model === 'balanced' ? 'active' : ''}`}
            onClick={() => { onModelSelect('balanced'); setIsModelDropdownOpen(false); }}
          >
            {useSystemStore.getState().branding.models?.balanced?.displayName || 'Balanced'}
          </button>
          <button
            type="button"
            className={`model-dropdown-item ${activeSession.model === 'flagship' ? 'active' : ''}`}
            onClick={() => { onModelSelect('flagship'); setIsModelDropdownOpen(false); }}
          >
            {useSystemStore.getState().branding.models?.flagship?.displayName || 'Flagship'}
          </button>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
