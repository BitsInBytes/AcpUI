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
});
