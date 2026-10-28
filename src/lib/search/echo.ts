import type { AstNode } from "./parse";

export function echoAst(ast: AstNode | null): string {
  if (!ast) return "";
  return echo(ast);
}

function echo(node: AstNode): string {
  switch (node.type) {
    case "term":
      if (node.phrase) return `"${node.value}"`;
      if (node.wildcard) return `${node.value}*`;
      return node.value;
    case "and":
      return `(${echo(node.left)} AND ${echo(node.right)})`;
    case "or":
      return `(${echo(node.left)} OR ${echo(node.right)})`;
    case "and_not":
      return `(${echo(node.left)} AND NOT ${echo(node.right)})`;
  }
}
