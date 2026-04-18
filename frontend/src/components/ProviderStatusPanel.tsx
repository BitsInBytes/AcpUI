import React, { useState } from 'react';
import { Activity, Clock, Info, X } from 'lucide-react';
import { useSystemStore } from '../store/useSystemStore';
import type { ProviderStatus, ProviderStatusItem } from '../types';
import './ProviderStatusPanel.css';

const ProviderStatusPanels: React.FC<{ providerId?: string | null }> = ({ providerId }) => {
  const statusByProvider = useSystemStore(state => state.providerStatusByProviderId);
  
  const statuses = providerId 
    ? [statusByProvider[providerId]].filter(Boolean)
    : Object.values(statusByProvider).filter(s => s && s.sections?.some(section => section.items?.length > 0));

  if (statuses.length === 0) return null;

  return (
    <div className="provider-status-container">
      {statuses.map(status => (
        <ProviderStatusPanelSingle key={status.providerId || status.title} status={status} />
      ))}
    </div>
  );
};

const ProviderStatusPanelSingle: React.FC<{ status: ProviderStatus }> = ({ status }) => {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  if (!status || !status.sections?.some(section => section.items?.length > 0)) return null;

  const summaryItems = getSummaryItems(status);

  return (
    <>
      <section className="provider-status-panel" aria-label={`${status.title || 'Provider'} status`}>
        <div className="provider-status-header">
          <div className="provider-status-title">
            <Activity size={13} />
            <span>{status.title || 'Provider'}</span>
          </div>
          {status.subtitle && <span className="provider-status-subtitle">{status.subtitle}</span>}
        </div>

        <div className="provider-status-summary">
          {status.summary?.title && <div className="provider-status-summary-title">{status.summary.title}</div>}
          <div className="provider-status-summary-grid">
            {summaryItems.map(item => <ProviderStatusRow key={item.id} item={item} compact />)}
          </div>
        </div>

        <div className="provider-status-footer">
          {status.updatedAt && (
            <div className="provider-status-updated">
              <Clock size={11} />
              <span>{formatUpdatedAt(status.updatedAt)}</span>
            </div>
          )}
          <button className="provider-status-details-btn" onClick={() => setIsDetailsOpen(true)} title="Provider status details">
            <Info size={12} />
            <span>Details</span>
          </button>
        </div>

      </section>

      {isDetailsOpen && (
        <ProviderStatusModal status={status} onClose={() => setIsDetailsOpen(false)} />
      )}
    </>
  );
};

function ProviderStatusModal({ status, onClose }: { status: ProviderStatus; onClose: () => void }) {
  return (
    <div className="provider-status-modal-overlay" role="presentation" onMouseDown={onClose}>
      <div className="provider-status-modal" role="dialog" aria-modal="true" aria-label={`${status.title || 'Provider'} status details`} onMouseDown={e => e.stopPropagation()}>
        <div className="provider-status-modal-header">
          <div>
            <div className="provider-status-modal-title">{status.title || 'Provider'} Status</div>
            {status.subtitle && <div className="provider-status-modal-subtitle">{status.subtitle}</div>}
          </div>
          <button className="provider-status-modal-close" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="provider-status-modal-body">
          {status.sections.filter(section => section.items?.length > 0).map(section => (
            <div key={section.id} className="provider-status-modal-section">
              {section.title && <div className="provider-status-modal-section-title">{section.title}</div>}
              <div className="provider-status-modal-items">
                {section.items.map(item => <ProviderStatusRow key={item.id} item={item} />)}
              </div>
            </div>
          ))}
        </div>

        {status.updatedAt && (
          <div className="provider-status-modal-updated">
            Updated {formatUpdatedAt(status.updatedAt)}
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderStatusRow({ item, compact = false }: { item: ProviderStatusItem; compact?: boolean }) {
  const progress = item.progress ? clampProgress(item.progress.value) : null;
  const tone = item.tone || 'neutral';
  const inlineProgress = compact && progress !== null;

  return (
    <div className={`provider-status-row tone-${tone} ${compact ? 'compact' : ''}`}>
      {inlineProgress ? (
        <div className="provider-status-row-inline">
          <span className="provider-status-label">{item.label}</span>
          <div className="provider-status-progress" aria-label={item.progress?.label || `${item.label} progress`}>
            <div className="provider-status-progress-fill" style={{ width: `${progress! * 100}%` }} />
          </div>
          {item.value && <span className="provider-status-value">{item.value}</span>}
        </div>
      ) : (
        <>
          <div className="provider-status-row-main">
            <span className="provider-status-label">{item.label}</span>
            {item.value && <span className="provider-status-value">{item.value}</span>}
          </div>
          {progress !== null && (
            <div className="provider-status-progress" aria-label={item.progress?.label || `${item.label} progress`}>
              <div className="provider-status-progress-fill" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </>
      )}
      {item.detail && <div className="provider-status-detail">{item.detail}</div>}
    </div>
  );
}

function getSummaryItems(status: ProviderStatus) {
  if (status.summary?.items?.length) return status.summary.items;
  const firstSectionItems = status.sections.find(section => section.items?.length > 0)?.items || [];
  return firstSectionItems.slice(0, 2);
}

function clampProgress(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default ProviderStatusPanels;
