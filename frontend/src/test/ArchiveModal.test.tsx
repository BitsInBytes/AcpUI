import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ArchiveModal from '../components/ArchiveModal';

const defaultProps = () => ({
  archives: ['chat-2026-01', 'project-alpha', 'debug-session'],
  archiveSearch: '',
  setArchiveSearch: vi.fn(),
  onRestore: vi.fn(),
  onDelete: vi.fn(),
  restoring: null,
  onClose: vi.fn(),
});

describe('ArchiveModal', () => {
  it('renders list of archive names', () => {
    render(<ArchiveModal {...defaultProps()} />);
    expect(screen.getByText('chat-2026-01')).toBeInTheDocument();
    expect(screen.getByText('project-alpha')).toBeInTheDocument();
    expect(screen.getByText('debug-session')).toBeInTheDocument();
  });

  it('filters archives by search', () => {
    const props = defaultProps();
    props.archiveSearch = 'project';
    render(<ArchiveModal {...props} />);
    expect(screen.getByText('project-alpha')).toBeInTheDocument();
    expect(screen.queryByText('chat-2026-01')).not.toBeInTheDocument();
  });

  it('calls onRestore when clicking an archive', () => {
    const props = defaultProps();
    render(<ArchiveModal {...props} />);
    fireEvent.click(screen.getByText('project-alpha'));
    expect(props.onRestore).toHaveBeenCalledWith('project-alpha');
  });

  it('calls onDelete when clicking delete button', () => {
    const props = defaultProps();
    render(<ArchiveModal {...props} />);
    const deleteButtons = screen.getAllByTitle('Delete archive');
    fireEvent.click(deleteButtons[0]);
    expect(props.onDelete).toHaveBeenCalledWith('chat-2026-01');
  });

  it('shows empty message when no archives match', () => {
    const props = defaultProps();
    props.archives = [];
    render(<ArchiveModal {...props} />);
    expect(screen.getByText('No archived chats found.')).toBeInTheDocument();
  });
});
