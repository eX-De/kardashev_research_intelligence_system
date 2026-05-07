import { lazy, Suspense } from "react";

const MarkdownReport = lazy(() => import("./MarkdownReport.jsx"));

export function LazyMarkdownReport({ markdown }) {
  return (
    <Suspense fallback={<div className="paper-report markdown-report"><p className="muted">报告渲染中...</p></div>}>
      <MarkdownReport markdown={markdown} />
    </Suspense>
  );
}
