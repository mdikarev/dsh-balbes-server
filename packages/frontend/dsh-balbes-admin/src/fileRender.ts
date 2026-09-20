/** Client-side decision of how to render a workspace file's text content. */

export type FileRenderKind = "markdown" | "code" | "plain";

export const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/** highlight.js languages available in the `common` bundle only. */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  pyw: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  swift: "swift",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
  md: "markdown",
  markdown: "markdown"
};

/** Well-known extensionless filenames. */
export const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: "bash",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".bash_profile": "bash",
  ".profile": "bash"
};

const SHEBANG_LANGUAGES: Record<string, string> = {
  python: "python",
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  dash: "bash",
  ksh: "bash",
  node: "javascript",
  nodejs: "javascript",
  ruby: "ruby",
  perl: "perl",
  php: "php",
  lua: "lua",
  rscript: "r"
};

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function extensionOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

export function languageForPath(path: string): string | null {
  const base = basename(path).toLowerCase();
  const byName = LANGUAGE_BY_FILENAME[base];
  if (byName !== undefined) return byName;
  const ext = extensionOf(base);
  if (ext === "") return null;
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

export function detectShebangLanguage(content: string): string | null {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const line = firstLine.trim();
  if (!line.startsWith("#!")) return null;
  const parts = line.slice(2).trim().split(/\s+/);
  for (const part of [...parts].reverse()) {
    const name = (part.split("/").pop() ?? "").toLowerCase().replace(/[0-9.]+$/, "");
    const language = SHEBANG_LANGUAGES[name];
    if (name !== "" && language !== undefined) return language;
  }
  return null;
}

export function detectFileRenderKind(path: string, content: string): FileRenderKind {
  if (isMarkdownPath(path)) return "markdown";
  if (languageForPath(path) !== null) return "code";
  if (extensionOf(path) === "" && detectShebangLanguage(content) !== null) return "code";
  return "plain";
}
