/**
 * Markdown chunker — splits a page's Markdown into overlapping, embed-sized
 * chunks. Greedy paragraph packing: accumulate blocks until the target size,
 * then start a new chunk carrying a short overlap tail so a passage split
 * across a boundary stays retrievable from either side.
 */

const OVERLAP_CHARS = 200;

export function chunkMarkdown(markdown: string, targetChars: number): string[] {
  const clean = markdown.trim();
  if (!clean) return [];

  const blocks = clean.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
  };

  for (const block of blocks) {
    // A single oversized block (huge table/code) is hard-split on its own.
    if (block.length > targetChars) {
      flush();
      current = '';
      for (let i = 0; i < block.length; i += targetChars) {
        chunks.push(block.slice(i, i + targetChars).trim());
      }
      continue;
    }

    if (current.length + block.length + 2 > targetChars && current.length > 0) {
      flush();
      const tail = current.slice(-OVERLAP_CHARS);
      current = `${tail}\n\n${block}`;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  flush();

  return chunks;
}
