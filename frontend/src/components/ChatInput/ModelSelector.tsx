import React from 'react';
import type { ChatSession } from '../../types';
import { useSystemStore } from '../../store/useSystemStore';
import { getFooterModelChoices, getModelLabel, isModelChoiceActive } from '../../utils/modelOptions';
import { Settings } from 'lucide-react';
import './ModelSelector.css';

interface ModelSelectorProps {
  activeSession: ChatSession | undefined;
  isModelDropdownOpen: boolean;
  setIsModelDropdownOpen: (open: boolean) => void;
  onModelSelect: (model: string) => void;
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

  const brandingModels = useSystemStore.getState().branding.models;
  const modelName = getModelLabel(activeSession, brandingModels);
  const label = isCompacting ? `${modelName} (Compacting...)` : contextPct !== undefined ? `${modelName} (${Math.round(contextPct)}%)` : modelName;
  const modelChoices = getFooterModelChoices(activeSession, brandingModels);
  const hasQuickAccessModels = modelChoices.length > 0;
  const canOpenModelDropdown = !disabled && hasQuickAccessModels;

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
        onClick={() => canOpenModelDropdown && setIsModelDropdownOpen(!isModelDropdownOpen)}
        className={`model-indicator-btn ${!hasQuickAccessModels ? 'static' : ''}`}
        disabled={disabled || !hasQuickAccessModels}
      >
        {label}
      </button>

      {isModelDropdownOpen && hasQuickAccessModels && (
        <div className="model-dropdown-menu">
          {modelChoices.map(choice => (
            <button
              key={choice.selection}
              type="button"
              className={`model-dropdown-item ${isModelChoiceActive(activeSession, choice, brandingModels) ? 'active' : ''}`}
              onClick={() => { onModelSelect(choice.selection); setIsModelDropdownOpen(false); }}
              title={choice.description}
            >
              <span className="model-dropdown-item-name">{choice.name}</span>
              {choice.description && <span className="model-dropdown-item-desc">{choice.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
