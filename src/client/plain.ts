/**
 * Plain-text view of inline Markdown (mind map labels, exports).
 * @module dsh-mindplan/client/plain
 */
/** Strip inline markup (for the mind map and exports that want plain text). */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/~~([^~\n]+?)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*/g, '$1$2')
}
