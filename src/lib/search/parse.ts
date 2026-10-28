import { normaliseLeafTerm } from "./leaf";
import { scan, type Token } from "./scan";

export type AstNode =
  | { type: "term"; value: string; phrase?: boolean; wildcard?: boolean }
  | { type: "and"; left: AstNode; right: AstNode }
  | { type: "or"; left: AstNode; right: AstNode }
  | { type: "and_not"; left: AstNode; right: AstNode };

export type ParseError = {
  code: string;
  message: string;
  position: number;
};

export type ParseResult =
  | { ok: true; ast: AstNode | null; leafCount: number; wildcardCount: number }
  | { ok: false; error: ParseError };

const MAX_CHARS = 500;
const MAX_DEPTH = 8;
const MAX_LEAVES = 20;
const MAX_WILDCARDS = 5;
const MIN_PREFIX = 2;

class Parser {
  tokens: Token[];
  i = 0;
  leafCount = 0;
  wildcardCount = 0;
  depth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.i] ?? { kind: "EOF", value: "", start: 0, end: 0 };
  }

  take(): Token {
    const t = this.peek();
    this.i++;
    return t;
  }

  parse(): ParseResult {
    if (this.peek().kind === "EOF") {
      return { ok: true, ast: null, leafCount: 0, wildcardCount: 0 };
    }
    try {
      const ast = this.parseOr();
      if (this.peek().kind !== "EOF") {
        return {
          ok: false,
          error: {
            code: "unexpected_token",
            message: `Unexpected token (position ${this.peek().start})`,
            position: this.peek().start,
          },
        };
      }
      return {
        ok: true,
        ast,
        leafCount: this.leafCount,
        wildcardCount: this.wildcardCount,
      };
    } catch (e) {
      const err = e as ParseError;
      return { ok: false, error: err };
    }
  }

  fail(code: string, message: string, position: number): never {
    throw { code, message, position } satisfies ParseError;
  }

  /** Reject terms that normalise to nothing (FP-D1: would become match-all `%%`). */
  requireSearchableTerm(value: string, position: number): void {
    if (!normaliseLeafTerm(value).trim()) {
      this.fail("empty_term", "That term has no searchable characters", position);
    }
  }

  parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.peek().kind === "OR") {
      this.take();
      if (this.peek().kind === "EOF" || this.peek().kind === "RPAREN") {
        this.fail("dangling_or", `OR needs a term on both sides (position ${this.peek().start})`, this.peek().start);
      }
      const right = this.parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  parseAnd(): AstNode {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind === "AND") {
        this.take();
        if (this.peek().kind === "NOT") {
          this.take();
          const right = this.parseUnary();
          left = { type: "and_not", left, right };
          continue;
        }
        if (
          this.peek().kind === "EOF" ||
          this.peek().kind === "RPAREN" ||
          this.peek().kind === "OR" ||
          this.peek().kind === "AND"
        ) {
          this.fail(
            "dangling_and",
            `AND needs a term on both sides (position ${t.end})`,
            t.end,
          );
        }
        const right = this.parseUnary();
        left = { type: "and", left, right };
        continue;
      }
      if (
        t.kind === "WORD" ||
        t.kind === "PHRASE" ||
        t.kind === "WILDCARD" ||
        t.kind === "LPAREN"
      ) {
        // implicit AND
        const right = this.parseUnary();
        left = { type: "and", left, right };
        continue;
      }
      break;
    }
    return left;
  }

  parseUnary(): AstNode {
    const t = this.peek();
    if (t.kind === "NOT") {
      this.fail("bare_not", "Use AND NOT to exclude a term", t.start);
    }
    if (t.kind === "AND" || t.kind === "OR") {
      this.fail(
        "dangling_op",
        `${t.value} needs a term on both sides (position ${t.start})`,
        t.start,
      );
    }
    if (t.kind === "LPAREN") {
      this.take();
      this.depth++;
      if (this.depth > MAX_DEPTH) {
        this.fail("depth", "Query nests too deeply", t.start);
      }
      if (this.peek().kind === "RPAREN") {
        this.fail("empty_group", "Empty group", t.start);
      }
      const inner = this.parseOr();
      if (this.peek().kind !== "RPAREN") {
        this.fail("unbalanced", `Missing closing bracket (position ${this.peek().start})`, this.peek().start);
      }
      this.take();
      this.depth--;
      return inner;
    }
    if (t.kind === "PHRASE") {
      this.take();
      if (!t.value.trim()) this.fail("empty_phrase", "Empty phrase", t.start);
      this.requireSearchableTerm(t.value, t.start);
      this.leafCount++;
      if (this.leafCount > MAX_LEAVES) this.fail("leaves", "Too many terms", t.start);
      return { type: "term", value: t.value, phrase: true };
    }
    if (t.kind === "WILDCARD") {
      this.take();
      if (t.value.length < MIN_PREFIX) {
        this.fail("short_prefix", "Wildcard prefix must be at least 2 characters", t.start);
      }
      if (/[*]/.test(t.value) || t.value.includes("*")) {
        this.fail("bad_wildcard", "Wildcards go at the end of a single word", t.start);
      }
      this.requireSearchableTerm(t.value, t.start);
      this.leafCount++;
      this.wildcardCount++;
      if (this.wildcardCount > MAX_WILDCARDS) this.fail("wildcards", "Too many wildcards", t.start);
      if (this.leafCount > MAX_LEAVES) this.fail("leaves", "Too many terms", t.start);
      return { type: "term", value: t.value, wildcard: true };
    }
    if (t.kind === "WORD") {
      this.take();
      this.requireSearchableTerm(t.value, t.start);
      this.leafCount++;
      if (this.leafCount > MAX_LEAVES) this.fail("leaves", "Too many terms", t.start);
      return { type: "term", value: t.value };
    }
    this.fail("unexpected", `Unexpected token (position ${t.start})`, t.start);
  }
}

export function parseQuery(input: string): ParseResult {
  if (input.length > MAX_CHARS) {
    return {
      ok: false,
      error: {
        code: "too_long",
        message: `Query exceeds ${MAX_CHARS} characters`,
        position: 0,
      },
    };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: true, ast: null, leafCount: 0, wildcardCount: 0 };
  }
  const tokens = scan(input);
  // Detect unclosed quote: scan leaves PHRASE without closing — check raw
  if ((input.match(/"/g) ?? []).length % 2 === 1) {
    const pos = input.lastIndexOf('"');
    return {
      ok: false,
      error: { code: "unclosed_phrase", message: "Unclosed phrase", position: pos },
    };
  }
  // Reject mid-word wildcards like a*b
  for (const t of tokens) {
    if (t.kind === "WORD" && t.value.includes("*")) {
      return {
        ok: false,
        error: {
          code: "bad_wildcard",
          message: "Wildcards go at the end of a single word",
          position: t.start,
        },
      };
    }
  }
  return new Parser(tokens).parse();
}
