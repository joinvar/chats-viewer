import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import powershell from "highlight.js/lib/languages/powershell";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import java from "highlight.js/lib/languages/java";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";
import plaintext from "highlight.js/lib/languages/plaintext";

const languages = {
  bash,
  shell,
  sh: bash,
  powershell,
  ps1: powershell,
  javascript,
  js: javascript,
  typescript,
  ts: typescript,
  jsx: javascript,
  tsx: typescript,
  python,
  py: python,
  json,
  yaml,
  yml: yaml,
  xml,
  html: xml,
  css,
  go,
  rust,
  rs: rust,
  c,
  cpp,
  "c++": cpp,
  csharp,
  cs: csharp,
  java,
  sql,
  markdown,
  md: markdown,
  dockerfile,
  diff,
  patch: diff,
  ini,
  toml: ini,
  plaintext,
  text: plaintext,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { languages }]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
