import { lazy, memo, Suspense } from "react";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

export const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return <Suspense fallback={<div className="message-markdown">{content}</div>}><MarkdownRenderer content={content} /></Suspense>;
});
