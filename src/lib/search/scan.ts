export type TokenKind =
  | "LPAREN"
  | "RPAREN"
  | "AND"
  | "OR"
  | "NOT"
  | "WORD"
  | "PHRASE"
  | "WILDCARD"
  | "EOF";

export type Token = {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
};

/** Hand-written character-loop scanner (no regex). */
export function scan(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

  while (i < n) {
    const c = input[i]!;
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "LPAREN", value: "(", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "RPAREN", value: ")", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let value = "";
      while (i < n && input[i] !== '"') {
        value += input[i];
        i++;
      }
      if (i >= n) {
        tokens.push({ kind: "PHRASE", value, start, end: i });
        break;
      }
      i++; // closing quote
      tokens.push({ kind: "PHRASE", value, start, end: i });
      continue;
    }

    const start = i;
    let value = "";
    while (i < n) {
      const ch = input[i]!;
      if (isSpace(ch) || ch === "(" || ch === ")" || ch === '"') break;
      value += ch;
      i++;
    }

    if (value === "AND") {
      tokens.push({ kind: "AND", value, start, end: i });
    } else if (value === "OR") {
      tokens.push({ kind: "OR", value, start, end: i });
    } else if (value === "NOT") {
      tokens.push({ kind: "NOT", value, start, end: i });
    } else if (value.endsWith("*") && value.length > 1) {
      tokens.push({ kind: "WILDCARD", value: value.slice(0, -1), start, end: i });
    } else if (value === "*") {
      tokens.push({ kind: "WILDCARD", value: "", start, end: i });
    } else {
      tokens.push({ kind: "WORD", value, start, end: i });
    }
  }

  tokens.push({ kind: "EOF", value: "", start: n, end: n });
  return tokens;
}
