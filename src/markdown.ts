import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Markdown -> sanitized HTML. Vault thoughts and wraps are the operator's own
 * files, but captured content can embed externally-sourced text; sanitizing
 * closes the XSS -> /api/launch escalation path.
 */
export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }));
}
