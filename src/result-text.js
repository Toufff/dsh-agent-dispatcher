const limit = 262144;
/** Bound persistence without cutting a valid trailing contract or hiding ambiguity. */
export function captureResultText(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) return text;
  const blocks = [...text.matchAll(/<dispatch-result>([\s\S]*?)<\/dispatch-result>/g)];
  if (blocks.length === 1 && blocks[0][0].length < limit / 2 &&
      !text.slice(blocks[0].index + blocks[0][0].length).trim()) {
    return `${text.slice(0, Math.min(blocks[0].index, 4000))}\n[Long narrative omitted; complete result contract preserved.]\n${blocks[0][0]}`;
  }
  return 'Result exceeded the persistence limit without one unambiguous trailing contract. Return a concise result contract from the existing evidence; do not repeat operations.';
}
