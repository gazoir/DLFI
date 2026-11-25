import { escapeHtml, sanitizeHtml } from "../util/html.mjs";

/**
 * Convert light Markdown (as used in DLCE fields) to Foundry HTML.
 */
export function markdownToHtml(input) {
  const text = String(input ?? "").trim();
  if (!text) {
    return "";
  }
  if (/<[a-z][\s\S]*>/i.test(text) && !/\*\*[^*]+\*\*/.test(text)) {
    return sanitizeHtml(text);
  }

  const escaped = escapeHtml(text);
  const withBold = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const withItalic = withBold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    // Word-bounded so snake_case_names stay literal.
    .replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "<em>$1</em>");
  const withCode = withItalic.replace(/`([^`]+)`/g, "<code>$1</code>");

  const blocks = withCode.split(/\n{2,}/).map((block) => {
    const lines = block.split("\n").map((line) => line.trimEnd());
    return `<p>${lines.join("<br>")}</p>`;
  });
  return blocks.join("");
}
