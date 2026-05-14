import React, { memo, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseLocalFileLinkHref } from '../utils/localFileLinks';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

interface MemoizedMarkdownProps {
  content: string;
  isStreaming: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components?: any;
}

function markdownUrlTransform(value: string) {
  return parseLocalFileLinkHref(value) ? value : defaultUrlTransform(value);
}

/** A single completed markdown block — never re-renders once content is stable */
const MemoizedBlock = memo(
  ({ content, components }: { content: string; components?: MemoizedMarkdownProps['components'] }) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrlTransform}>
      {content}
    </ReactMarkdown>
  ),
  (prev, next) => prev.content === next.content
);
MemoizedBlock.displayName = 'MemoizedBlock';

/**
 * Parse the buffer with mdast and return source slices for each top-level block.
 * The last block is treated as "active" (still streaming); everything before it
 * is a syntactically complete construct safe to memoize.
 *
 * Uses position offsets from mdast nodes to slice the original string, which
 * preserves exact whitespace/formatting that ReactMarkdown will then re-parse.
 */
function splitIntoBlocks(content: string): { settled: string[]; active: string } {
  if (!content) return { settled: [], active: '' };

  let tree;
  try {
    tree = fromMarkdown(content, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
  } catch {
    return { settled: [], active: content };
  }

  const children = tree.children;
  if (children.length === 0) return { settled: [], active: content };
  if (children.length === 1) {
    return { settled: [], active: content };
  }

  const settled: string[] = [];
  for (let i = 0; i < children.length - 1; i++) {
    const node = children[i];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      // Position missing — fall back to treating remainder as active
      const lastSettledNode = children[i - 1];
      const cutoff = lastSettledNode?.position?.end.offset ?? 0;
      return { settled, active: content.slice(cutoff) };
    }
    settled.push(content.slice(start, end));
  }

  const lastNode = children[children.length - 1];
  const activeStart = lastNode.position?.start.offset;
  const active = activeStart !== undefined ? content.slice(activeStart) : '';

  return { settled, active };
}

/**
 * Streaming-optimized markdown renderer.
 *
 * While streaming, parses the buffer into mdast and splits on top-level block
 * boundaries. Completed blocks are memoized; only the trailing (in-progress)
 * block re-renders on each chunk. This avoids the partial-fence / partial-list
 * artifacts that arise when splitting on raw `\n\n` boundaries — a fenced code
 * block can legally contain blank lines, so naive splitting fragments it into
 * pieces the parser can't interpret correctly out of context.
 *
 * On stream end (`!isStreaming`) the entire buffer is rendered as a single
 * document for full correctness.
 */
const MemoizedMarkdown: React.FC<MemoizedMarkdownProps> = ({ content, isStreaming, components }) => {
  const { settled, active } = useMemo(
    () => (isStreaming ? splitIntoBlocks(content) : { settled: [], active: content }),
    [content, isStreaming]
  );

  if (!isStreaming) {
    return <MemoizedBlock content={content} components={components} />;
  }

  if (settled.length === 0) {
    return (
      <div className="streaming-block">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrlTransform}>
          {active}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <>
      {settled.map((block, i) => (
        <MemoizedBlock key={`${i}:${block.length}`} content={block} components={components} />
      ))}
      {active && (
        <div className="streaming-block">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrlTransform}>
            {active}
          </ReactMarkdown>
        </div>
      )}
    </>
  );
};

export default MemoizedMarkdown;
