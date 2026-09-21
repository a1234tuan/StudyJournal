import {
  Children,
  createElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Copy } from "lucide-react";
import { common, createLowlight } from "lowlight";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { copyTextToClipboard } from "../lib/clipboard";
import "katex/dist/katex.min.css";

interface AiMarkdownProps {
  content: string;
}

type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & { node?: unknown };

type HighlightNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string | string[] };
  children?: HighlightNode[];
};

const lowlight = createLowlight(common);

const languageAliases: Record<string, string> = {
  cplusplus: "cpp",
  "c++": "cpp",
  cs: "csharp",
  html: "xml",
  jsx: "javascript",
  js: "javascript",
  py: "python",
  shell: "bash",
  sh: "bash",
  ts: "typescript",
  tsx: "typescript",
};

const languageLabels: Record<string, string> = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  go: "Go",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  markdown: "Markdown",
  php: "PHP",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  xml: "HTML / XML",
  yaml: "YAML",
};

const normalizeLanguage = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  return languageAliases[normalized] ?? normalized;
};

const renderHighlightNode = (node: HighlightNode, key: string): ReactNode => {
  if (node.type === "text") return node.value ?? "";
  if (node.type !== "element") {
    return node.children?.map((child, index) => renderHighlightNode(child, `${key}-${index}`));
  }
  const className = Array.isArray(node.properties?.className)
    ? node.properties.className.join(" ")
    : node.properties?.className;
  return createElement(
    node.tagName ?? "span",
    { key, className },
    node.children?.map((child, index) => renderHighlightNode(child, `${key}-${index}`)),
  );
};

const highlightedCode = (code: string, language: string): ReactNode => {
  if (!language || !lowlight.registered(language)) return code;
  const tree = lowlight.highlight(language, code) as HighlightNode;
  return tree.children?.map((node, index) => renderHighlightNode(node, `token-${index}`));
};

const MarkdownCodeBlock = ({ children, node: _node, ...props }: MarkdownPreProps) => {
  const codeElement = Children.toArray(children).find((child) => isValidElement(child));
  const hasCodeElement = isValidElement<{ className?: string; children?: ReactNode }>(codeElement);
  const source = hasCodeElement ? String(codeElement.props.children ?? "").replace(/\n$/, "") : "";
  const declaredLanguage = hasCodeElement
    ? /(?:^|\s)language-([^\s]+)/.exec(codeElement.props.className ?? "")?.[1] ?? ""
    : "";
  const language = normalizeLanguage(declaredLanguage);
  const languageLabel = languageLabels[language] ?? declaredLanguage ?? "纯文本";
  const highlighted = useMemo(() => hasCodeElement ? highlightedCode(source, language) : "", [hasCodeElement, language, source]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<number>();

  useEffect(() => () => {
    if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copyCode = async () => {
    const copied = await copyTextToClipboard(source);
    setCopyState(copied ? "copied" : "failed");
    if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  };

  const copyLabel = copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制代码";

  if (!hasCodeElement) {
    return <pre {...props}>{children}</pre>;
  }

  return (
    <figure className="ai-code-block" data-language={language || undefined}>
      <figcaption className="ai-code-block-header">
        <span className="ai-code-block-language">{languageLabel}</span>
        <button type="button" className="ai-code-copy-button" onClick={() => void copyCode()} aria-label={copyLabel}>
          {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
          <span>{copyLabel}</span>
        </button>
      </figcaption>
      <div className="ai-code-block-scroll" tabIndex={0} aria-label={`${languageLabel} 代码`}>
        <pre {...props}>
          <code className={["hljs", codeElement.props.className].filter(Boolean).join(" ")}>{highlighted}</code>
        </pre>
      </div>
    </figure>
  );
};

export const AiMarkdown = ({ content }: AiMarkdownProps) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
    components={{ pre: MarkdownCodeBlock }}
  >
    {content}
  </ReactMarkdown>
);
