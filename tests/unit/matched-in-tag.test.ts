import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchedInTag } from "@/components/MatchedInTag";
import { strings } from "@/lib/ui/strings";

describe("MatchedInTag side sets", () => {
  it("renders nothing for original alone", () => {
    const html = renderToStaticMarkup(
      createElement(MatchedInTag, { sides: ["original"] }),
    );
    expect(html).toBe("");
  });

  it("summary only", () => {
    const html = renderToStaticMarkup(
      createElement(MatchedInTag, { sides: ["summary"] }),
    );
    expect(html).toContain(strings.matchedInSummary);
  });

  it("translation and summary", () => {
    const html = renderToStaticMarkup(
      createElement(MatchedInTag, { sides: ["translation", "summary"] }),
    );
    expect(html).toContain(strings.matchedInTranslationAndSummary);
  });

  it("original and summary", () => {
    const html = renderToStaticMarkup(
      createElement(MatchedInTag, { sides: ["original", "summary"] }),
    );
    expect(html).toContain(strings.matchedInOriginalAndSummary);
  });

  it("translation only", () => {
    const html = renderToStaticMarkup(
      createElement(MatchedInTag, { sides: ["translation"] }),
    );
    expect(html).toContain(strings.matchedInTranslation);
  });
});
