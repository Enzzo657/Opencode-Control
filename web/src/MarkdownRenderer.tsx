import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "./i18n";

export default function MarkdownRenderer({ content }: { content: string }) {
  const { t } = useI18n();
  return <div className="message-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt }) => <span className="blocked-image">{t("markdown.image", { alt: alt || t("markdown.noAlt") })}</span> }}>{content}</ReactMarkdown></div>;
}
