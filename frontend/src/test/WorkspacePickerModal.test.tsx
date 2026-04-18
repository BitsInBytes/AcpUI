import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorkspacePickerModal from '../components/WorkspacePickerModal';
import type { WorkspaceCwd } from '../types';
import { useSystemStore } from '../store/useSystemStore';

const workspaces: WorkspaceCwd[] = [
  { label: 'Demo Project', path: 'C:\\repos\\demo-project' },
  { label: 'Library-Project', path: 'C:\\repos\\lib-project', agent: 'lib-dev' },
  { label: 'MyAgentUI', path: 'C:\\repos\\MyAgentUI' },
];

describe('WorkspacePickerModal', () => {
  beforeEach(() => {
    useSystemStore.setState({ branding: { supportsAgentSwitching: true } as any });
  });

  it('renders all workspaces', () => {
    render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Demo Project')).toBeInTheDocument();
    expect(screen.getByText('Library-Project')).toBeInTheDocument();
    expect(screen.getByText('MyAgentUI')).toBeInTheDocument();
  });

  it('renders header', () => {
    render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Open Workspace')).toBeInTheDocument();
  });

  it('filters workspaces by label', () => {
    render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), { target: { value: 'demo' } });
    expect(screen.getByText('Demo Project')).toBeInTheDocument();
    expect(screen.queryByText('Library-Project')).not.toBeInTheDocument();
  });

  it('filters workspaces by path', () => {
    render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), { target: { value: 'MyAgentUI' } });
    expect(screen.getByText('MyAgentUI')).toBeInTheDocument();
    expect(screen.queryByText('Demo Project')).not.toBeInTheDocument();
  });

  it('shows empty message when no match', () => {
    render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), { target: { value: 'zzzzz' } });
    expect(screen.getByText('No workspaces found.')).toBeInTheDocument();
  });

  it('calls onSelect and onClose when workspace clicked', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<WorkspacePickerModal workspaces={workspaces} onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByText('Demo Project'));
    expect(onSelect).toHaveBeenCalledWith(workspaces[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when overlay clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.click(container.querySelector('.archive-modal-overlay')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when modal body clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.click(container.querySelector('.archive-modal')!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows agent badge when workspace has agent', () => {
    render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('lib-dev')).toBeInTheDocument();
  });

  it('clears search when clear button clicked', () => {
    const { container } = render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), { target: { value: 'demo' } });
    expect(screen.queryByText('Library-Project')).not.toBeInTheDocument();
    fireEvent.click(container.querySelector('.search-clear')!);
    expect(screen.getByText('Library-Project')).toBeInTheDocument();
  });

  it('renders workspace paths', () => {
    render(<WorkspacePickerModal workspaces={workspaces} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('C:\\repos\\demo-project')).toBeInTheDocument();
  });
});
