/**
 * Convert light Markdown (as used in DLCE fields) to Foundry HTML.
 */
export function markdownToHtml(input) {
  const text = String(input ?? "").trim();
  if (!text) {
    return "";
  }
  if (/<[a-z][\s\S]*>/i.test(text) && !/\*\*[^*]+\*\*/.test(text)) {
    return text;
  }

  const escaped = escapeHtml(text);
  const withBold = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const withItalic = withBold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");
  const withCode = withItalic.replace(/`([^`]+)`/g, "<code>$1</code>");

  const blocks = withCode.split(/\n{2,}/).map((block) => {
    const lines = block.split("\n").map((line) => line.trimEnd());
    return `<p>${lines.join("<br>")}</p>`;
  });
  return blocks.join("");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
