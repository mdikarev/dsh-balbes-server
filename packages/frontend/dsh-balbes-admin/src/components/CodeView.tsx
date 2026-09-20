import hljs from "highlight.js/lib/common";

interface CodeViewProps {
  content: string;
  language: string;
}

/** Highlights standalone code; unknown languages fall back to plain text. */
export default function CodeView({ content, language }: CodeViewProps) {
  if (language === "" || hljs.getLanguage(language) === undefined) {
    return (
      <pre className="ws-file-content" data-testid="file-content">
        {content}
      </pre>
    );
  }
  const html = hljs.highlight(content, { language, ignoreIllegals: true }).value;
  return (
    <pre className="ws-file-content" data-testid="file-content">
      <code
        className={`hljs language-${language}`}
        data-testid="file-code"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}
