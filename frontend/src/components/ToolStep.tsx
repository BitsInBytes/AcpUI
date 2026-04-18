import React, { useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Settings, Layout } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { SystemEvent } from '../types';
import { renderToolOutput } from './renderToolOutput';
import SubAgentPanel from './SubAgentPanel';
import { useElapsed } from '../utils/timer';

interface ToolStepProps {
  step: { type: 'tool'; event: SystemEvent };
  isCollapsed: boolean;
  onToggle: () => void;
  onOpenInCanvas: (filePath: string) => void;
  markdownComponents: object;
}

const getFilePathFromEvent = (event: SystemEvent): string | undefined => {
  // UI-owned tools — checked here before asking the provider
  if (event.toolName === 'ux_invoke_shell') return undefined;
  if (event.toolName === 'ux_invoke_subagents') return undefined;

  // Provider-categorized tools
  if (event.isShellCommand) return undefined;
  if (event.toolCategory === 'glob') return undefined;
  if (event.toolCategory === 'file_read') return event.filePath;
  if (event.toolCategory === 'file_edit') return event.filePath;

  const titleLower = (event.title || '').toLowerCase();
  const idLower = (event.id || '').toLowerCase();
  if (
    titleLower.includes('running shell') ||
    idLower.includes('shell') ||
    titleLower.includes('list directory') ||
    idLower.includes('list_directory')
  ) {
    return undefined;
  }

  if (event.filePath) return event.filePath;

  if (event.title) {
    const toolMatch = event.title.match(/Running (?:replace|read_file|write_file|read_file_parallel): ([a-zA-Z0-9_.:\-/\\]+)/i);
    if (toolMatch && toolMatch[1]) {
      const path = toolMatch[1].trim();
      if (path.includes('...')) return undefined;
      return path;
    }

    const genericMatch = event.title.match(/Running [a-zA-Z0-9_ -]+: ([a-zA-Z0-9_.:\-/\\]+)/);
    if (genericMatch && genericMatch[1]) {
      const path = genericMatch[1].trim();
      if (path.includes('...')) return undefined;
      return path;
    }

    if (event.title.includes('.') && !event.title.includes(' ')) {
      const path = event.title.trim();
      if (path.includes('...')) return undefined;
      return path;
    }
  }

  if (event.output) {
    const indexMatch = event.output.match(/^Index:\s*(.*)$/m);
    if (indexMatch && indexMatch[1]) return indexMatch[1].trim();
    const diffMatch = event.output.match(/^--- (.*)$/m);
    if (diffMatch && diffMatch[1] && diffMatch[1] !== 'old') return diffMatch[1].trim();
  }

  return undefined;
};

const isShellOutputEvent = (event: SystemEvent): boolean => {
  const titleLower = (event.title || '').toLowerCase();
  const idLower = (event.id || '').toLowerCase();
  return event.toolName === 'ux_invoke_shell' ||
    event.isShellCommand === true ||
    event.output?.startsWith('$ ') === true ||
    titleLower.includes('running shell') ||
    idLower.includes('shell');
};

const ToolStep: React.FC<ToolStepProps> = ({ step, isCollapsed, onToggle, onOpenInCanvas, markdownComponents }) => {
  const filePath = getFilePathFromEvent(step.event);
  const elapsed = useElapsed(step.event.startTime, step.event.endTime);
  const outputContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const outputContainer = outputContainerRef.current;
    if (!outputContainer || isCollapsed || !isShellOutputEvent(step.event)) return;
    outputContainer.scrollTop = outputContainer.scrollHeight;
  }, [isCollapsed, step.event]);

  return (
    <div className={`system-event ${step.event.status}`}>
      <div className="timeline-step-header-wrapper">
        <button className="timeline-step-header" onClick={onToggle}>
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <Settings size={14} className="step-icon" />
          <span className="event-title">{step.event.title}</span>
          {step.event.status === 'in_progress' && <span className="event-pulse">...</span>}
          {elapsed && <span className="tool-timer">{elapsed}</span>}
        </button>
        {filePath && (
          <button
            className="canvas-hoist-btn"
            onClick={(e) => { e.stopPropagation(); onOpenInCanvas(filePath); }}
            title="Open current file state in Canvas"
          >
            <Layout size={14} />
          </button>
        )}
      </div>

      <AnimatePresence>
        {!isCollapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="step-content-wrapper"
          >
            {(step.event.output || step.event.status === 'failed') && (
              <div className="tool-output-details-unified">
                <div className="tool-output-container" ref={outputContainerRef}>
                  {renderToolOutput(step.event.output, markdownComponents, step.event.filePath)}
                </div>
              </div>
            )}
            {/* SubAgentPanel renders inline for tools that spawn sub-agents */}
            {(step.event.toolName === 'ux_invoke_subagents' || step.event.toolName === 'ux_invoke_counsel') && (
              <SubAgentPanel />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ToolStep;
