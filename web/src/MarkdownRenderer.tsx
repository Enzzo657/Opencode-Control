import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownRenderer({ content }: { content: string }) {
  return <div className="message-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt }) => <span className="blocked-image">Изображение: {alt || "без описания"}</span> }}>{content}</ReactMarkdown></div>;
}
