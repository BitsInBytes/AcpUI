import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolStep from '../components/ToolStep';
import type { SystemEvent } from '../types';

vi.mock('react-markdown', () => ({
  default: ({ children }: any) => <div>{children}</div>
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('framer-motion', () => ({
  motion: { div: ({ children, ...props }: any) => <div {...props}>{children}</div> },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

// Mock SubAgentPanel to capture props passed by ToolStep
vi.mock('../components/SubAgentPanel', () => ({
  default: ({ invocationId }: { invocationId?: string }) => (
    <div data-testid="sub-agent-panel" data-invocation-id={invocationId ?? ''} />
  ),
}));

vi.mock('../components/ShellToolTerminal', () => ({
  default: ({ event }: { event: SystemEvent }) => (
    <div data-testid="shell-tool-terminal" data-run-id={event.shellRunId ?? ''} />
  ),
}));

const makeEvent = (overrides: Partial<SystemEvent> = {}): SystemEvent => ({
  id: 'tool-1',
  title: 'Running read_file: src/app.ts',
  status: 'completed',
  ...overrides,
});

const defaultProps = () => ({
  step: { type: 'tool' as const, event: makeEvent() },
  isCollapsed: false,
  onToggle: vi.fn(),
  onOpenInCanvas: vi.fn(),
  markdownComponents: {},
});

describe('ToolStep', () => {
  it('renders tool title', () => {
    render(<ToolStep {...defaultProps()} />);
    expect(screen.getByText('Running read_file: src/app.ts')).toBeInTheDocument();
  });

  it('uses the AcpUI UX icon for ux tools', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ isAcpUxTool: true, canonicalName: 'ux_read_file', title: 'Read File: app.ts' });
    render(<ToolStep {...props} />);

    expect(screen.getByLabelText('AcpUI UX tool')).toBeInTheDocument();
    expect(screen.queryByLabelText('System tool')).not.toBeInTheDocument();
  });

  it('keeps the system icon for non-ux tools', () => {
    render(<ToolStep {...defaultProps()} />);

    expect(screen.getByLabelText('System tool')).toBeInTheDocument();
    expect(screen.queryByLabelText('AcpUI UX tool')).not.toBeInTheDocument();
  });

  it('shows pulse indicator when status is in_progress', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ status: 'in_progress' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.event-pulse')).toBeInTheDocument();
  });

  it('shows output when expanded and output exists', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ output: 'file contents here' });
    render(<ToolStep {...props} />);
    expect(screen.getByText('file contents here')).toBeInTheDocument();
  });

  it('auto-scrolls live shell output to the bottom when output changes', () => {
    const props = defaultProps();
    props.step.event = makeEvent({
      toolName: 'ux_invoke_shell',
      status: 'in_progress',
      output: '$ many-lines\none'
    });
    const { container, rerender } = render(<ToolStep {...props} />);
    const outputPane = container.querySelector('.tool-output-container') as HTMLDivElement;
    Object.defineProperty(outputPane, 'scrollHeight', { configurable: true, value: 1234 });

    props.step.event = { ...props.step.event, output: '$ many-lines\none\ntwo' };
    rerender(<ToolStep {...props} />);

    expect(outputPane.scrollTop).toBe(1234);
  });

  it('hides content when collapsed', () => {
    const props = defaultProps();
    props.isCollapsed = true;
    props.step.event = makeEvent({ output: 'should not appear' });
    render(<ToolStep {...props} />);
    expect(screen.queryByText('should not appear')).not.toBeInTheDocument();
  });

  it('shows canvas button when filePath exists', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ filePath: '/src/app.ts' });
    const { container } = render(<ToolStep {...props} />);
    const canvasBtn = container.querySelector('.canvas-hoist-btn');
    expect(canvasBtn).toBeInTheDocument();
    fireEvent.click(canvasBtn!);
    expect(props.onOpenInCanvas).toHaveBeenCalledWith('/src/app.ts');
  });

  it('shows completed status icon', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ status: 'completed' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.system-event.completed')).toBeInTheDocument();
    expect(container.querySelector('.event-pulse')).not.toBeInTheDocument();
  });

  it('shows failed status with error styling', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ status: 'failed', output: 'Error occurred' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.system-event.failed')).toBeInTheDocument();
    expect(screen.getByText('Error occurred')).toBeInTheDocument();
  });

  it('renders diff output correctly', () => {
    const diffText = '--- old\n+++ new\n@@ -1,3 +1,3 @@\n-old line\n+new line\n context';
    const props = defaultProps();
    props.step.event = makeEvent({ output: diffText });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.diff-output')).toBeInTheDocument();
    expect(container.querySelector('.diff-add')).toBeInTheDocument();
    expect(container.querySelector('.diff-remove')).toBeInTheDocument();
  });

  it('shows No output when output is undefined and status is failed', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ status: 'failed', output: undefined });
    props.isCollapsed = false;
    render(<ToolStep {...props} />);
    expect(screen.getByText('No output or error details provided.')).toBeInTheDocument();
  });

  it('clicking header calls onToggle', () => {
    const props = defaultProps();
    render(<ToolStep {...props} />);
    const header = screen.getByText('Running read_file: src/app.ts');
    fireEvent.click(header);
    expect(props.onToggle).toHaveBeenCalled();
  });

  it('passes invocationId to SubAgentPanel for ux_invoke_subagents', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ toolName: 'ux_invoke_subagents', invocationId: 'inv-test-42' });
    render(<ToolStep {...props} />);
    const panel = screen.getByTestId('sub-agent-panel');
    expect(panel).toBeInTheDocument();
    expect(panel.getAttribute('data-invocation-id')).toBe('inv-test-42');
  });

  it('uses canonicalName to render SubAgentPanel when provider toolName is generic', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ toolName: 'tooluse_123', canonicalName: 'ux_invoke_subagents', invocationId: 'inv-canonical' });
    render(<ToolStep {...props} />);
    const panel = screen.getByTestId('sub-agent-panel');
    expect(panel).toBeInTheDocument();
    expect(panel.getAttribute('data-invocation-id')).toBe('inv-canonical');
  });

  it('suppresses instructional output for sub-agent start tools', () => {
    const props = defaultProps();
    props.step.event = makeEvent({
      toolName: 'ux_invoke_subagents',
      canonicalName: 'ux_invoke_subagents',
      invocationId: 'inv-test-42',
      output: 'Sub-agents have been started asynchronously. Call ux_check_subagents next.',
      status: 'completed'
    });

    render(<ToolStep {...props} />);

    expect(screen.getByTestId('sub-agent-panel')).toBeInTheDocument();
    expect(screen.queryByText(/Sub-agents have been started asynchronously/)).not.toBeInTheDocument();
  });

  it('keeps failure output visible for sub-agent start tools', () => {
    const props = defaultProps();
    props.step.event = makeEvent({
      toolName: 'ux_invoke_subagents',
      canonicalName: 'ux_invoke_subagents',
      invocationId: 'inv-failed',
      output: 'Failed to start sub-agents',
      status: 'failed'
    });

    render(<ToolStep {...props} />);

    expect(screen.getByTestId('sub-agent-panel')).toBeInTheDocument();
    expect(screen.getByText('Failed to start sub-agents')).toBeInTheDocument();
  });

  it('keeps output visible for ux_check_subagents', () => {
    const props = defaultProps();
    props.step.event = makeEvent({
      toolName: 'ux_check_subagents',
      canonicalName: 'ux_check_subagents',
      output: 'Completed sub-agent results',
      status: 'completed'
    });

    render(<ToolStep {...props} />);

    expect(screen.queryByTestId('sub-agent-panel')).not.toBeInTheDocument();
    expect(screen.getByText('Completed sub-agent results')).toBeInTheDocument();
  });

  it('passes invocationId to SubAgentPanel for ux_invoke_counsel', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ toolName: 'ux_invoke_counsel', invocationId: 'inv-counsel-7' });
    render(<ToolStep {...props} />);
    const panel = screen.getByTestId('sub-agent-panel');
    expect(panel).toBeInTheDocument();
    expect(panel.getAttribute('data-invocation-id')).toBe('inv-counsel-7');
  });

  it('does not render SubAgentPanel for regular tool calls', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ toolName: 'read_file' });
    render(<ToolStep {...props} />);
    expect(screen.queryByTestId('sub-agent-panel')).not.toBeInTheDocument();
  });

  it('renders ShellToolTerminal for Shell V2 tool steps', () => {
    const props = defaultProps();
    props.step.event = makeEvent({
      toolName: 'ux_invoke_shell',
      shellRunId: 'shell-run-1',
      status: 'in_progress',
      output: 'final output should not render here'
    });
    render(<ToolStep {...props} />);
    expect(screen.getByTestId('shell-tool-terminal')).toHaveAttribute('data-run-id', 'shell-run-1');
    expect(screen.queryByText('final output should not render here')).not.toBeInTheDocument();
  });

  it('renders diff lines with correct classes for + and -', () => {
    const diffText = '--- old\n+++ new\n-removed line\n+added line';
    const props = defaultProps();
    props.step.event = makeEvent({ output: diffText });
    const { container } = render(<ToolStep {...props} />);
    const addLines = container.querySelectorAll('.diff-add');
    const removeLines = container.querySelectorAll('.diff-remove');
    expect(addLines.length).toBeGreaterThan(0);
    expect(removeLines.length).toBeGreaterThan(0);
  });
});


describe('ToolStep - getFilePathFromEvent extraction', () => {
  it('extracts path from "Running write_file: path" title', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Running write_file: /src/utils/helper.ts' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).toBeInTheDocument();
  });

  it('extracts path from "Running read_file_parallel: path" title', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Running read_file_parallel: C:\\repos\\file.cs' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).toBeInTheDocument();
  });

  it('returns undefined for shell commands', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Running shell: ls -la' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).not.toBeInTheDocument();
  });

  it('returns undefined for non-file AcpUI UX tools even when a file path is present', () => {
    const props = defaultProps();
    props.step.event = makeEvent({
      isAcpUxTool: true,
      isFileOperation: false,
      canonicalName: 'ux_web_fetch',
      filePath: '/src/app.ts',
      title: 'Fetch: https://example.test'
    });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).not.toBeInTheDocument();
  });

  it('returns undefined for sub-agent status tools even when a file path is present', () => {
    const props = defaultProps();
    props.step.event = makeEvent({
      canonicalName: 'ux_abort_subagents',
      filePath: '/src/app.ts',
      title: 'Abort Subagents'
    });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).not.toBeInTheDocument();
  });

  it('returns undefined for list_directory commands', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Running list directory: /src', id: 'list_directory' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).not.toBeInTheDocument();
  });

  it('returns undefined when path contains ellipsis', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Running replace: D:\\Git\\...\\file.tsx' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).not.toBeInTheDocument();
  });

  it('extracts path from generic "Running tool_name: path" pattern', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Running some_tool: /tmp/output.json' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).toBeInTheDocument();
  });

  it('extracts path from title that is just a filename with dot', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'package.json' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).toBeInTheDocument();
  });

  it('extracts path from output Index: line', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Some tool', output: 'Index: src/main.ts\n===\n+added' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).toBeInTheDocument();
  });

  it('extracts path from output diff --- line', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Some tool', output: '--- src/app.ts\n+++ src/app.ts\n+line' });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.canvas-hoist-btn')).toBeInTheDocument();
  });

  it('does not extract from output --- old (literal "old")', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ title: 'Some tool', output: '--- old\n+++ new\n+line', filePath: undefined });
    const { container } = render(<ToolStep {...props} />);
    // "old" is excluded, but filePath from event.filePath is also undefined
    // The diff --- line returns "old" which is filtered out
    expect(container.querySelector('.canvas-hoist-btn')).not.toBeInTheDocument();
  });

  it('uses event.filePath when available', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ filePath: '/direct/path.ts', title: 'Running shell: echo hi' });
    const { container } = render(<ToolStep {...props} />);
    // shell is excluded before filePath check
    expect(container.querySelector('.canvas-hoist-btn')).not.toBeInTheDocument();
  });

  it('canvas hoist button calls onOpenInCanvas with extracted path', () => {
    const props = defaultProps();
    props.step.event = makeEvent({ filePath: '/src/index.ts' });
    const { container } = render(<ToolStep {...props} />);
    const btn = container.querySelector('.canvas-hoist-btn')!;
    fireEvent.click(btn);
    expect(props.onOpenInCanvas).toHaveBeenCalledWith('/src/index.ts');
  });

  it('shows elapsed timer when startTime and endTime are set', () => {
    const props = defaultProps();
    const now = Date.now();
    props.step.event = makeEvent({ startTime: now - 5000, endTime: now });
    const { container } = render(<ToolStep {...props} />);
    expect(container.querySelector('.tool-timer')).toBeInTheDocument();
  });
});
