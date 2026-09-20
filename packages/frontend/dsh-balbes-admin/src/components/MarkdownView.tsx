import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

interface MarkdownViewProps {
  content: string;
}

interface MdastNode {
  type?: string;
  value?: string;
  children?: MdastNode[];
}

/** Matches a whitespace-separated run of HTML comments and nothing else. */
const HTML_COMMENTS_ONLY = /^(?:\s*<!--[\s\S]*?-->)*\s*$/;

/** Drops HTML comment nodes so authoring markers never render as escaped text. */
function remarkStripHtmlComments() {
  return (tree: MdastNode): void => {
    const walk = (node: MdastNode): void => {
      if (node.children === undefined) return;
      node.children = node.children.filter(
        (child) => !(child.type === "html" && HTML_COMMENTS_ONLY.test(child.value ?? ""))
      );
      for (const child of node.children) walk(child);
    };
    walk(tree);
  };
}

/** Renders markdown safely: raw HTML is not parsed and dangerous URLs are dropped. */
export default function MarkdownView({ content }: MarkdownViewProps) {
  return (
    <div className="ws-markdown" data-testid="file-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkStripHtmlComments]}
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
