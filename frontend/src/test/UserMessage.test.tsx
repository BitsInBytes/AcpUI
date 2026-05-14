import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import UserMessage from '../components/UserMessage';

// Mock ReactMarkdown to render children as plain text so tests aren't
// coupled to its internals or to markdown parsing behaviour.
vi.mock('react-markdown', () => ({
  defaultUrlTransform: (value: string) => value,
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown-content">{children}</div>
  ),
}));
vi.mock('remark-gfm', () => ({ default: {} }));

function makeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    role: 'user' as const,
    content: 'Hello **world**',
    attachments: [],
    isArchived: false,
    ...overrides,
  } as any;
}

describe('UserMessage', () => {
  it('renders the "You" role label', () => {
    render(<UserMessage message={makeMessage()} markdownComponents={{}} />);
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('renders the message content via ReactMarkdown', () => {
    render(<UserMessage message={makeMessage()} markdownComponents={{}} />);
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('Hello **world**');
  });

  it('applies the markdown-body class to the content div', () => {
    const { container } = render(<UserMessage message={makeMessage()} markdownComponents={{}} />);
    expect(container.querySelector('.markdown-body')).toBeInTheDocument();
  });

  it('applies the "archived" CSS class when message.isArchived is true', () => {
    const { container } = render(
      <UserMessage message={makeMessage({ isArchived: true })} markdownComponents={{}} />
    );
    expect(container.querySelector('.message-wrapper')).toHaveClass('archived');
  });

  it('does not apply the "archived" class when message.isArchived is false', () => {
    const { container } = render(<UserMessage message={makeMessage()} markdownComponents={{}} />);
    expect(container.querySelector('.message-wrapper')).not.toHaveClass('archived');
  });

  it('renders no attachments section when attachments array is empty', () => {
    const { container } = render(
      <UserMessage message={makeMessage({ attachments: [] })} markdownComponents={{}} />
    );
    expect(container.querySelector('.user-attachments')).not.toBeInTheDocument();
  });

  it('renders no attachments section when attachments is absent', () => {
    const { container } = render(
      <UserMessage message={makeMessage({ attachments: undefined })} markdownComponents={{}} />
    );
    expect(container.querySelector('.user-attachments')).not.toBeInTheDocument();
  });

  it('renders an image attachment as an <img> with correct src', () => {
    const message = makeMessage({
      attachments: [{ mimeType: 'image/png', data: 'abc123', name: 'photo.png' }],
    });
    render(<UserMessage message={message} markdownComponents={{}} />);
    const img = screen.getByRole('img', { name: 'photo.png' });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'data:image/png;base64,abc123');
  });

  it('renders a non-image attachment as a file indicator with 📎 and the filename', () => {
    const message = makeMessage({
      attachments: [{ mimeType: 'text/plain', name: 'notes.txt' }],
    });
    render(<UserMessage message={message} markdownComponents={{}} />);
    expect(screen.getByText(/📎 notes.txt/)).toBeInTheDocument();
  });

  it('detects image type from the "type" field when mimeType is absent', () => {
    const message = makeMessage({
      attachments: [{ type: 'image/jpeg', data: 'xyz', name: 'pic.jpg' }],
    });
    render(<UserMessage message={message} markdownComponents={{}} />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('renders multiple mixed attachments correctly', () => {
    const message = makeMessage({
      attachments: [
        { mimeType: 'image/jpeg', data: 'xyz', name: 'photo.jpg' },
        { mimeType: 'application/pdf', name: 'doc.pdf' },
      ],
    });
    render(<UserMessage message={message} markdownComponents={{}} />);
    expect(screen.getByRole('img', { name: 'photo.jpg' })).toBeInTheDocument();
    expect(screen.getByText(/📎 doc.pdf/)).toBeInTheDocument();
  });

  it('skips rendering an image when data is absent', () => {
    const message = makeMessage({
      attachments: [{ mimeType: 'image/png', name: 'no-data.png' }], // no data field
    });
    render(<UserMessage message={message} markdownComponents={{}} />);
    // No img rendered — falls through to file indicator path
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/📎 no-data.png/)).toBeInTheDocument();
  });
});
