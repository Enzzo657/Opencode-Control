import { lazy, memo, Suspense } from "react";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

export const MessageMarkdown = memo(function MessageMarkdown({ content, projectId, projectRoot }: { content: string; projectId?: string; projectRoot?: string }) {
  return <Suspense fallback={<div className="message-markdown">{content}</div>}><MarkdownRenderer content={content} projectId={projectId} projectRoot={projectRoot} /></Suspense>;
});
