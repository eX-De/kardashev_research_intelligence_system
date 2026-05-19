import { lazy, Suspense } from "react";

import { MarkdownReportLoader } from "./Loading.jsx";

const MarkdownReport = lazy(() => import("./MarkdownReport.jsx"));

export function LazyMarkdownReport({ markdown }) {
  return (
    <Suspense fallback={<MarkdownReportLoader />}>
      <MarkdownReport markdown={markdown} />
    </Suspense>
  );
}
