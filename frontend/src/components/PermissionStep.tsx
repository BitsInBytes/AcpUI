import React from 'react';
import { Settings } from 'lucide-react';
import type { TimelineStep } from '../types';

type PermissionTimelineStep = Extract<TimelineStep, { type: 'permission' }>;

interface PermissionStepProps {
  step: PermissionTimelineStep;
  onRespond: (requestId: number, optionId: string, toolCallId?: string) => void;
}

const PermissionStep: React.FC<PermissionStepProps> = ({ step, onRespond }) => (
  <div className="timeline-step permission-step">
    <div className="permission-request-unified">
      <div className="timeline-step-header-wrapper">
        <div className="timeline-step-header non-clickable">
          <Settings size={14} className="step-icon" />
          <span className="event-title">Permission Requested</span>
        </div>
      </div>
      <div className="step-content-wrapper">
        <div className="permission-details">
          <p className="permission-prompt">
            {step.request.toolCall?.title || 'The agent is requesting permission to proceed.'}
          </p>
          <div className="permission-options">
            {step.request.options.map(opt => (
              <button
                key={opt.optionId}
                className={`permission-btn ${opt.kind}`}
                onClick={() => onRespond(step.request.id, opt.optionId, step.request.toolCall?.toolCallId)}
                disabled={!!step.response}
              >
                {opt.name}
              </button>
            ))}
          </div>
          {step.response && (
            <div className="permission-response">
              Selection: <strong>{step.response}</strong>
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
);

export default PermissionStep;
