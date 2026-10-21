// Delivery tags as text, with no imports: the hooks module reads them, and
// Claude Code lets a hooks module import only its own files and "claude-code".
export function deliveryRefs(text) {
  return [...text.matchAll(/\[codex-delivery=([A-Za-z0-9_-]+)\](?=\s*(?:\r?\n|<\/event>|$))/g)].map((match) => match[1]);
}
export const stripDeliveryTags = (text) => text.replace(/ ?\[codex-delivery=[A-Za-z0-9_-]+\]/g, "");
