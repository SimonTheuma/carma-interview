import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";

export const SANITISER_VERSION = "1";

export type Transformation = {
  kind: string;
  counts: Record<string, number>;
  removedHashes: string[];
};

export type SanitiseResult = {
  text: string | null;
  transformations: Transformation[];
};

const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "noscript"]);

function hashFragment(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function isHiddenStyle(style: string | undefined): boolean {
  if (!style) return false;
  const s = style.toLowerCase().replace(/\s+/g, "");
  return (
    s.includes("display:none") ||
    s.includes("visibility:hidden") ||
    s.includes("font-size:0") ||
    /width:0(?:px|%)?/.test(s) ||
    /height:0(?:px|%)?/.test(s)
  );
}

/** Reduce HTML/markup to plain text with a real HTML parser (no regex for markup). */
export function reduceMarkup(input: string | null | undefined): SanitiseResult {
  if (input === null || input === undefined) {
    return { text: null, transformations: [] };
  }

  const tagCounts: Record<string, number> = {};
  const removedHashes: string[] = [];
  let removedTextNodes = 0;
  let comments = 0;
  const parts: string[] = [];
  const skipStack: string[] = [];
  const hideStack: boolean[] = [];

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
        if (DROP_WITH_CONTENT.has(tag)) {
          skipStack.push(tag);
          return;
        }
        const parentHidden = hideStack[hideStack.length - 1] ?? false;
        const hiddenEl = isHiddenStyle(attribs.style) || parentHidden;
        hideStack.push(hiddenEl);
        if (tag === "br") parts.push("\n");
        if (tag === "p" || tag === "div" || tag === "li") {
          if (parts.length && !parts[parts.length - 1]?.endsWith("\n")) parts.push("\n");
        }
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (DROP_WITH_CONTENT.has(tag) && skipStack[skipStack.length - 1] === tag) {
          skipStack.pop();
          return;
        }
        if (!DROP_WITH_CONTENT.has(tag)) hideStack.pop();
        if (tag === "p" || tag === "div" || tag === "li") {
          if (parts.length && !parts[parts.length - 1]?.endsWith("\n")) parts.push("\n");
        }
      },
      ontext(text) {
        if (skipStack.length > 0) {
          removedTextNodes++;
          removedHashes.push(hashFragment(text));
          return;
        }
        if (hideStack[hideStack.length - 1]) {
          removedHashes.push(hashFragment(text));
          return;
        }
        parts.push(text);
      },
      oncomment(data) {
        comments++;
        removedHashes.push(hashFragment(data));
      },
    },
    { decodeEntities: true },
  );

  parser.write(input);
  parser.end();

  const text = parts
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const transformations: Transformation[] = [];
  if (Object.keys(tagCounts).length > 0 || comments > 0 || removedTextNodes > 0) {
    transformations.push({
      kind: "markup_removed",
      counts: { ...tagCounts, comments, removed_text_nodes: removedTextNodes },
      removedHashes: removedHashes.slice(0, 20),
    });
  }

  return { text: text.length === 0 ? null : text, transformations };
}
