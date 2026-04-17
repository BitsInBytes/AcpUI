import React, { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MemoizedMarkdownProps {
  content: string;
  isStreaming: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components?: any;
}

/** A single completed markdown block — never re-renders once created */
const MemoizedBlock = memo(
  ({ content, components }: { content: string; components?: MemoizedMarkdownProps['components'] }) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  ),
  (prev, next) => prev.content === next.content
);
MemoizedBlock.displayName = 'MemoizedBlock';

/**
 * Streaming-optimized markdown renderer.
 * Splits content into blocks on double-newline boundaries.
 * Completed blocks are memoized. Only the active block re-renders.
 */
const MemoizedMarkdown: React.FC<MemoizedMarkdownProps> = ({ content, isStreaming, components }) => {
  const blocks = useMemo(() => {
    if (!content) return [];
    return content.split(/\n\n/);
  }, [content]);

  if (!isStreaming) {
    return <MemoizedBlock content={content} components={components} />;
  }

  if (blocks.length <= 1) {
    return (
      <div className="streaming-block">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  const settled = blocks.slice(0, -1);
  const active = blocks[blocks.length - 1];

  return (
    <>
      {settled.map((block, i) => (
        <MemoizedBlock key={i} content={block} components={components} />
      ))}
      <div className="streaming-block">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {active}
        </ReactMarkdown>
      </div>
    </>
  );
};

export default MemoizedMarkdown;
