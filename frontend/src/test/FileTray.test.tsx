import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FileTray from '../components/FileTray';

describe('FileTray', () => {
  const mockAttachments = [
    { name: 'image.png', size: 1024, mimeType: 'image/png', path: '/path/image.png' },
    { name: 'code.js', size: 2048, mimeType: 'application/javascript', path: '/path/code.js' }
  ];

  it('renders nothing when empty', () => {
    const { container } = render(<FileTray attachments={[]} onRemove={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders file chips correctly', () => {
    render(<FileTray attachments={mockAttachments} onRemove={vi.fn()} />);
    expect(screen.getByText('image.png')).toBeInTheDocument();
    expect(screen.getByText('1.0 KB')).toBeInTheDocument();
    expect(screen.getByText('code.js')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('calls onRemove when remove button is clicked', () => {
    const onRemove = vi.fn();
    const { container } = render(<FileTray attachments={mockAttachments} onRemove={onRemove} />);

    const removeButtons = container.querySelectorAll('.file-chip-remove');
    fireEvent.click(removeButtons[0]);

    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('renders FileText icon for plain text files (not image or code)', () => {
    const attachments = [{ name: 'notes.txt', size: 512, mimeType: 'text/plain' }];
    render(<FileTray attachments={attachments} onRemove={vi.fn()} />);
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
  });

  it('formats file size in MB for large files', () => {
    const attachments = [{ name: 'video.mp4', size: 5 * 1024 * 1024, mimeType: 'video/mp4' }];
    render(<FileTray attachments={attachments} onRemove={vi.fn()} />);
    expect(screen.getByText('5.0 MB')).toBeInTheDocument();
  });
});
