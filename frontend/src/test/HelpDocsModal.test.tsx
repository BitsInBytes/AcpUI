import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import HelpDocsModal from '../components/HelpDocsModal';
import { useSystemStore } from '../store/useSystemStore';
import { useUIStore } from '../store/useUIStore';

describe('HelpDocsModal', () => {
  const mockSocket = {
    emit: vi.fn((event: string, payload: unknown, callback?: (res: unknown) => void) => {
      if (event === 'help_docs_list') {
        callback?.({
          root: 'D:/Git/AcpUI',
          files: [
            { name: 'BOOTSTRAP.md', path: 'BOOTSTRAP.md', directory: '' },
            { name: 'FEATURE_DOC_TEMPLATE.md', path: 'documents/FEATURE_DOC_TEMPLATE.md', directory: 'documents' },
            { name: 'Frontend Architecture.md', path: 'documents/Frontend Architecture.md', directory: 'documents' },
            { name: 'README.md', path: 'providers/test-provider/README.md', directory: 'providers/test-provider' },
          ],
        });
      }
      if (event === 'help_docs_read') {
        const filePath = (payload as { filePath: string }).filePath;
        const body = filePath === 'BOOTSTRAP.md'
          ? '# BOOTSTRAP.md\n[Feature template](documents/FEATURE_DOC_TEMPLATE.md)'
          : `# ${filePath}\nDocument body`;
        callback?.({ content: body, filePath });
      }
    }),
    on: vi.fn(),
    off: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: mockSocket as never });
      useUIStore.setState({ isHelpDocsOpen: true });
    });
  });

  it('renders when open and loads the default Markdown document', () => {
    const { container } = render(<HelpDocsModal />);

    expect(screen.getByText('Help')).toBeInTheDocument();
    expect(container.querySelector('.hd-viewer-content.markdown-body')).toBeInTheDocument();
    expect(screen.getByText('D:/Git/AcpUI')).toBeInTheDocument();
    expect(screen.getAllByText('BOOTSTRAP.md').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'BOOTSTRAP.md' })).toBeInTheDocument();
    expect(mockSocket.emit).toHaveBeenCalledWith('help_docs_list', {}, expect.any(Function));
    expect(mockSocket.emit).toHaveBeenCalledWith('help_docs_read', { filePath: 'BOOTSTRAP.md' }, expect.any(Function));
  });

  it('does not render when closed', () => {
    act(() => { useUIStore.setState({ isHelpDocsOpen: false }); });

    const { container } = render(<HelpDocsModal />);

    expect(container.innerHTML).toBe('');
  });

  it('filters the Markdown tree by path', () => {
    render(<HelpDocsModal />);

    fireEvent.change(screen.getByPlaceholderText('Search Markdown files'), { target: { value: 'providers' } });

    const tree = screen.getByRole('tree');
    expect(within(tree).getByText('providers')).toBeInTheDocument();
    expect(within(tree).queryByText('BOOTSTRAP.md')).not.toBeInTheDocument();
  });

  it('opens a selected Markdown document in the viewer', () => {
    render(<HelpDocsModal />);

    fireEvent.click(screen.getByText('documents'));
    fireEvent.click(screen.getByText('Frontend Architecture.md'));

    expect(mockSocket.emit).toHaveBeenCalledWith('help_docs_read', { filePath: 'documents/Frontend Architecture.md' }, expect.any(Function));
    expect(screen.getByRole('heading', { name: 'documents/Frontend Architecture.md' })).toBeInTheDocument();
  });

  it('opens internal Markdown links in the Help viewer', () => {
    render(<HelpDocsModal />);

    fireEvent.click(screen.getByRole('link', { name: 'Feature template' }));

    expect(mockSocket.emit).toHaveBeenCalledWith('help_docs_read', { filePath: 'documents/FEATURE_DOC_TEMPLATE.md' }, expect.any(Function));
    expect(screen.getByRole('heading', { name: 'documents/FEATURE_DOC_TEMPLATE.md' })).toBeInTheDocument();
  });

  it('closes on overlay click', () => {
    render(<HelpDocsModal />);

    fireEvent.click(document.querySelector('.help-docs-overlay')!);

    expect(useUIStore.getState().isHelpDocsOpen).toBe(false);
  });
});
