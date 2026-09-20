import { describe, expect, it } from "vitest";
import {
  detectFileRenderKind,
  detectShebangLanguage,
  languageForPath
} from "../src/fileRender";

describe("languageForPath", () => {
  it("maps common code extensions to highlight languages", () => {
    expect(languageForPath("src/a.ts")).toBe("typescript");
    expect(languageForPath("a.tsx")).toBe("typescript");
    expect(languageForPath("a.js")).toBe("javascript");
    expect(languageForPath("a.json")).toBe("json");
    expect(languageForPath("a.py")).toBe("python");
    expect(languageForPath("a.go")).toBe("go");
    expect(languageForPath("a.rs")).toBe("rust");
    expect(languageForPath("a.sh")).toBe("bash");
    expect(languageForPath("a.yaml")).toBe("yaml");
    expect(languageForPath("a.toml")).toBe("ini");
    expect(languageForPath("a.sql")).toBe("sql");
    expect(languageForPath("a.md")).toBe("markdown");
  });

  it("is case-insensitive", () => {
    expect(languageForPath("A.TS")).toBe("typescript");
    expect(languageForPath("README.MD")).toBe("markdown");
  });

  it("maps well-known filenames without extensions", () => {
    expect(languageForPath("Dockerfile")).toBe("bash");
    expect(languageForPath("Makefile")).toBe("makefile");
    expect(languageForPath("path/to/Dockerfile")).toBe("bash");
    expect(languageForPath(".bashrc")).toBe("bash");
  });

  it("returns null for unknown extensions and plain text", () => {
    expect(languageForPath("notes.txt")).toBeNull();
    expect(languageForPath("archive.bin")).toBeNull();
    expect(languageForPath("README")).toBeNull();
  });
});

describe("detectShebangLanguage", () => {
  it("detects interpreters from a shebang line", () => {
    expect(detectShebangLanguage("#!/bin/bash\necho hi")).toBe("bash");
    expect(detectShebangLanguage("#!/usr/bin/env python3\nprint(1)")).toBe("python");
    expect(detectShebangLanguage("#!/usr/bin/env node\nconsole.log(1)")).toBe("javascript");
    expect(detectShebangLanguage("#!/usr/bin/env ruby\nputs 1")).toBe("ruby");
  });

  it("returns null without a shebang or for unknown interpreters", () => {
    expect(detectShebangLanguage("hello")).toBeNull();
    expect(detectShebangLanguage("/* not a script */")).toBeNull();
    expect(detectShebangLanguage("#!/usr/bin/env weirdbin\nx")).toBeNull();
  });
});

describe("detectFileRenderKind", () => {
  it("marks markdown extensions as markdown", () => {
    expect(detectFileRenderKind("README.md", "# hi")).toBe("markdown");
    expect(detectFileRenderKind("doc.markdown", "# hi")).toBe("markdown");
  });

  it("marks known code extensions and filenames as code", () => {
    expect(detectFileRenderKind("src/a.ts", "const x = 1")).toBe("code");
    expect(detectFileRenderKind("Dockerfile", "FROM node")).toBe("code");
  });

  it("uses a shebang for extensionless files", () => {
    expect(detectFileRenderKind("run", "#!/bin/sh\necho hi")).toBe("code");
  });

  it("falls back to plain for unknown types", () => {
    expect(detectFileRenderKind("notes.txt", "hello")).toBe("plain");
    expect(detectFileRenderKind(".gitignore", "node_modules")).toBe("plain");
    expect(detectFileRenderKind("data.csv", "a,b")).toBe("plain");
  });
});
