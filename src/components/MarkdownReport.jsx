import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { normalizeMathDelimiters } from "../lib/markdownMath.js";

const remarkPlugins = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }]
];
const rehypePlugins = [[rehypeKatex, { strict: false, throwOnError: false }]];

const markdownComponents = {
  a({ node: _node, ...props }) {
    return <a {...props} rel="noreferrer" target="_blank" />;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="markdown-table-wrap">
        <table {...props} />
      </div>
    );
  }
};

export default function MarkdownReport({ markdown }) {
  const content = normalizeMathDelimiters(String(markdown || "")).trim();
  if (!content) return null;
  return (
    <div className="paper-report markdown-report">
      <ReactMarkdown
        components={markdownComponents}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
