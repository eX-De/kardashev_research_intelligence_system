import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

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

function normalizeMathDelimiters(markdown) {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith("```")) return part;
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, "\n$$\n$1\n$$\n")
        .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$");
    })
    .join("");
}

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
