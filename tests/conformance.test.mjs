// Guards the decisions made for this site. Run: node --test
// Every check scans the files on disk (no hand-kept list) with comments stripped.
// SITE_ROOT can point at another copy of the site, which is how each check was
// proven to fail when its rule is broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  process.env.SITE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
);

const SKIPPED_DIRS = new Set(["tests", "node_modules", ".git"]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : walk(path);
    }
    return [path];
  });
}

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");

const files = walk(root).map((path) => ({
  path,
  name: relative(root, path),
  ext: extname(path).toLowerCase(),
}));
const read = (file) => stripComments(readFileSync(file.path, "utf8"));

const cssFiles = files.filter((f) => f.ext === ".css");
const htmlFiles = files.filter((f) => f.ext === ".html");
const textFiles = files.filter((f) =>
  [".html", ".css", ".svg", ".txt", ".js", ".json", ".xml", ".md"].includes(
    f.ext,
  ),
);
const isTokens = (file) => file.name === join("styles", "tokens.css");

function offenders(fileList, pattern) {
  return fileList.flatMap((file) =>
    [...read(file).matchAll(pattern)].map((m) => `${file.name}: ${m[0]}`),
  );
}

test("the scan actually sees the site", () => {
  assert.ok(htmlFiles.length >= 1, "no HTML files found");
  assert.ok(cssFiles.some(isTokens), "styles/tokens.css not found");
  assert.ok(cssFiles.some((f) => !isTokens(f)), "no stylesheet besides tokens");
});

test("colour literals live only in tokens.css", () => {
  const literal = /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|oklch|oklab|lab|lch)a?\(/gi;
  const inCss = offenders(cssFiles.filter((f) => !isTokens(f)), literal);
  // In HTML only style attributes and <style> blocks can carry colour.
  const inHtml = htmlFiles.flatMap((file) => {
    const html = read(file);
    const styled = [
      ...html.matchAll(/<style[\s\S]*?<\/style>/gi),
      ...html.matchAll(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi),
    ].map((m) => m[0]);
    return styled
      .filter((chunk) => chunk.match(literal))
      .map((chunk) => `${file.name}: ${chunk.slice(0, 60)}`);
  });
  assert.deepEqual([...inCss, ...inHtml], []);
});

test("every custom property in use is defined in tokens.css", () => {
  const tokens = cssFiles.filter(isTokens).map(read).join("\n");
  const defined = new Set(
    [...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
  );
  const used = [...cssFiles, ...htmlFiles].flatMap((file) =>
    [...read(file).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => ({
      file: file.name,
      name: m[1],
    })),
  );
  assert.ok(used.length > 0, "no var() usage found");
  const missing = used
    .filter((u) => !defined.has(u.name))
    .map((u) => `${u.file}: ${u.name}`);
  assert.deepEqual(missing, []);
});

test("focus outlines are never removed", () => {
  assert.deepEqual(
    offenders([...cssFiles, ...htmlFiles], /outline(?:-style|-width)?\s*:\s*(?:none|0)\b[^;}"']*/gi),
    [],
  );
});

test("a visible focus style exists", () => {
  const css = cssFiles.map(read).join("\n");
  const rule = css.match(/:focus-visible\s*\{([^}]*)\}/);
  assert.ok(rule, "no :focus-visible rule");
  assert.match(rule[1], /outline\s*:\s*[^;]*solid/);
});

test("light only: no dark-mode branch, and the page says so", () => {
  assert.deepEqual(
    offenders([...cssFiles, ...htmlFiles], /prefers-color-scheme/gi),
    [],
  );
  for (const file of htmlFiles) {
    assert.match(
      read(file),
      /<meta\s+name="color-scheme"\s+content="light"\s*\/?>/i,
      `${file.name} is missing <meta name="color-scheme" content="light">`,
    );
  }
});

test("no gradients, background images or textures", () => {
  assert.deepEqual(
    offenders(cssFiles, /[\w-]*gradient\(|background-image\s*:|url\(/gi),
    [],
  );
});

test("solid hairlines are the only separator style", () => {
  assert.deepEqual(offenders(cssFiles, /\b(?:dashed|dotted|double|groove|ridge)\b/gi), []);
});

test("only GitHub is published: no email, mailto or LinkedIn", () => {
  const pattern = /mailto:|linkedin\.com|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
  assert.deepEqual(offenders(textFiles, pattern), []);
});

test("nothing loads from another origin", () => {
  // Navigation links (<a href>) may point anywhere; loaded resources may not.
  const loaders = [
    /<(?:link|script|img|iframe|source|video|audio|embed|object)\b[^>]*?\s(?:href|src|data|srcset)\s*=\s*["']\s*(?:https?:)?\/\/[^"']*["']/gi,
    /@import\s+[^;]*/gi,
    /url\(\s*["']?(?:https?:)?\/\/[^)]*\)/gi,
  ];
  const found = loaders.flatMap((p) => offenders([...htmlFiles, ...cssFiles], p));
  assert.deepEqual(found, []);
});

test("document structure: one h1, labelled sections, hidden decoration", () => {
  for (const file of htmlFiles) {
    const html = read(file);
    assert.equal((html.match(/<h1\b/gi) ?? []).length, 1, `${file.name}: h1 count`);
    assert.match(html, /<html\s[^>]*lang="[a-z-]+"/i, `${file.name}: lang`);
    assert.equal((html.match(/<h[456]\b/gi) ?? []).length, 0, `${file.name}: h4-h6`);

    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const sections = [...html.matchAll(/<section\b([^>]*)>/gi)].map((m) => m[1]);
    for (const attrs of sections) {
      const label = attrs.match(/aria-labelledby="([^"]+)"/);
      assert.ok(label, `${file.name}: <section${attrs}> has no aria-labelledby`);
      assert.ok(ids.has(label[1]), `${file.name}: no element with id="${label[1]}"`);
    }
  }
});

test("every local file the pages reference exists", () => {
  const refs = htmlFiles.flatMap((file) => {
    const html = read(file);
    const attrs = [...html.matchAll(/\s(?:href|src)\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
    const srcsets = [...html.matchAll(/\ssrcset\s*=\s*"([^"]+)"/gi)].flatMap((m) =>
      m[1].split(",").map((part) => part.trim().split(/\s+/)[0]),
    );
    return [...attrs, ...srcsets]
      .filter((ref) => ref && !/^(?:[a-z]+:|\/\/|#)/i.test(ref))
      .map((ref) => ({ file: file.name, ref, path: join(dirname(file.path), ref.split(/[?#]/)[0]) }));
  });
  assert.ok(refs.length > 0, "no local references found");
  const known = new Set(files.map((f) => f.path));
  const missing = refs.filter((r) => !known.has(r.path)).map((r) => `${r.file}: ${r.ref}`);
  assert.deepEqual(missing, []);
});

test("images declare alt, width and height", () => {
  const bad = htmlFiles.flatMap((file) =>
    [...read(file).matchAll(/<img\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((tag) => !/\salt\s*=/.test(tag) || !/\swidth\s*=\s*"\d+"/.test(tag) || !/\sheight\s*=\s*"\d+"/.test(tag))
      .map((tag) => `${file.name}: ${tag.replace(/\s+/g, " ").slice(0, 80)}`),
  );
  assert.deepEqual(bad, []);
});
