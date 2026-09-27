import { describe, expect, it } from "vitest";
import { loadConfig, normalizeCookie, parseProjectAliases } from "../src/config.js";
import { extractProjectId } from "../src/context.js";
import { globToRegExp, normalizeRelPath, resolveInProject } from "../src/files.js";

describe("config", () => {
  it("uses overleaf.com defaults", () => {
    const c = loadConfig({ HOME: "/home/x" });
    expect(c.webBaseUrl).toBe("https://www.overleaf.com");
    expect(c.gitBaseUrl).toBe("https://git.overleaf.com");
    expect(c.readOnly).toBe(false);
  });

  it("derives the Server Pro git URL", () => {
    const c = loadConfig({ OVERLEAF_URL: "https://latex.example.edu/" });
    expect(c.gitBaseUrl).toBe("https://latex.example.edu/git");
  });

  it("parses aliases in both formats", () => {
    expect(parseProjectAliases("thesis=aaa, paper = bbb")).toEqual({ thesis: "aaa", paper: "bbb" });
    expect(parseProjectAliases('{"My Paper": "ccc"}')).toEqual({ "My Paper": "ccc" });
  });

  it("normalises cookies", () => {
    expect(normalizeCookie("s%3Aabc.def")).toBe("overleaf_session2=s%3Aabc.def");
    expect(normalizeCookie("Cookie: overleaf_session2=x; GCLB=y")).toBe("overleaf_session2=x; GCLB=y");
    expect(normalizeCookie("  ")).toBeUndefined();
  });
});

describe("project ids", () => {
  const id = "64a1b2c3d4e5f60718293a4b";
  it("extracts ids from ids and URLs", () => {
    expect(extractProjectId(id.toUpperCase())).toBe(id);
    expect(extractProjectId(`https://www.overleaf.com/project/${id}`)).toBe(id);
    expect(extractProjectId(`https://www.overleaf.com/project/${id}/detached`)).toBe(id);
    expect(extractProjectId(`https://git.overleaf.com/${id}`)).toBe(id);
    expect(extractProjectId(`https://latex.example.edu/git/${id}`)).toBe(id);
    expect(extractProjectId("thesis")).toBeUndefined();
  });
});

describe("paths", () => {
  it("normalises relative paths", () => {
    expect(normalizeRelPath("./a/b.tex")).toBe("a/b.tex");
    expect(normalizeRelPath("/a\\b.tex")).toBe("a/b.tex");
    expect(normalizeRelPath("a/../b.tex")).toBe("b.tex");
  });

  it("refuses escapes and .git", () => {
    expect(() => resolveInProject("/p", "../x")).toThrow(/outside/);
    expect(() => resolveInProject("/p", "a/../../x")).toThrow(/outside/);
    expect(() => resolveInProject("/p", ".git/config")).toThrow(/\.git/);
    expect(() => resolveInProject("/p", ".")).toThrow();
    expect(resolveInProject("/p", "sub/.gitignore")).toBe("/p/sub/.gitignore");
  });

  it("matches globs", () => {
    expect(globToRegExp("*.tex").test("chapters/one.tex")).toBe(true);
    expect(globToRegExp("chapters/*.tex").test("chapters/one.tex")).toBe(true);
    expect(globToRegExp("chapters/*.tex").test("chapters/x/one.tex")).toBe(false);
    expect(globToRegExp("chapters/**").test("chapters/x/one.tex")).toBe(true);
    expect(globToRegExp("*.{tex,bib}").test("refs.bib")).toBe(true);
    expect(globToRegExp("*.tex").test("main.texx")).toBe(false);
  });
});
