import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

interface MarkdownViewProps {
  content: string;
}

/** Renders markdown safely: raw HTML is not parsed and dangerous URLs are dropped. */
export default function MarkdownView({ content }: MarkdownViewProps) {
  return (
    <div className="ws-markdown" data-testid="file-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          img: ({ node, ...props }) => <img {...props} loading="lazy" referrerPolicy="no-referrer" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
