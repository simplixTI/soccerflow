/**
 * KB indexing: split an owner-authored entry into chunks, embed each chunk
 * with OpenAI, and store them in kb_chunks so RAG retrieval sees the new
 * teaching immediately. Used by the admin function on every insert.
 *
 * Mirrors scripts/backfill-kb-embeddings.mjs so both paths produce the same
 * chunks for the same text.
 */
import { embed } from './openai.ts';
import { insertKbChunk, deleteKbChunksForEntry } from './store.ts';

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;

export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= CHUNK_SIZE) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    let slice = clean.slice(start, end);
    if (end < clean.length) {
      const paragraphBreak = slice.lastIndexOf('\n\n');
      const newlineBreak = slice.lastIndexOf('\n');
      const sentenceBreak = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
      );
      const whitespace = slice.lastIndexOf(' ');
      const min = CHUNK_SIZE * 0.4;
      const boundary =
        paragraphBreak >= min ? paragraphBreak + 2
        : newlineBreak >= min ? newlineBreak + 1
        : sentenceBreak >= min ? sentenceBreak + 2
        : whitespace >= min ? whitespace + 1
        : slice.length;
      slice = slice.slice(0, boundary);
    }
    chunks.push(slice.trim());
    start += Math.max(slice.length - CHUNK_OVERLAP, Math.floor(CHUNK_SIZE / 2));
  }
  return chunks.filter((c) => c.length > 20);
}

/**
 * (Re)index one entry. Wipes previous chunks for the id first so it is safe
 * to call again after an edit. Throws on embedding/DB failure so the caller
 * can decide whether the entry insert should be rolled back.
 */
export async function indexKbEntry(
  entry: { id: string; category: string; text: string },
): Promise<number> {
  const chunks = chunkText(entry.text);
  await deleteKbChunksForEntry(entry.id);
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i]);
    await insertKbChunk({
      entry_id: entry.id,
      category: entry.category,
      text: chunks[i],
      chunk_index: i,
      embedding,
    });
  }
  return chunks.length;
}
