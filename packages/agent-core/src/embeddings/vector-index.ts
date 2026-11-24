/**
 * A compact in-memory index of embedding vectors, shared by the knowledge base
 * and chat search.
 *
 * Every vector is normalised to length 1 and stored one byte per dimension in
 * a single packed array, so 30,000 vectors of 768 dimensions take 23 MB and a
 * search is one tight loop over that array: no per-row objects, no parsing.
 * A dot product against the (full-precision) query is then the cosine
 * similarity, to within about a percent.
 *
 * The index holds vectors of one size. Vectors of another size (an embedding
 * model was changed) are not comparable and are simply left out.
 */

const SCALE = 127;
/** Vectors scored when estimating the background level of a large index. */
const BACKGROUND_SAMPLE = 2000;

/** A vector scaled to length 1; a zero vector stays zero. */
export function normalise(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const length = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (length > 0) for (let i = 0; i < vector.length; i++) out[i] = vector[i] / length;
  return out;
}

/** The stored form of a vector: normalised, one signed byte per dimension. */
export function quantise(vector: ArrayLike<number>): Int8Array {
  const unit = normalise(vector);
  const out = new Int8Array(unit.length);
  for (let i = 0; i < unit.length; i++) out[i] = Math.max(-SCALE, Math.min(SCALE, Math.round(unit[i] * SCALE)));
  return out;
}

/** A stored vector as bytes for a SQLite BLOB, and back. */
export const vectorToBlob = (stored: Int8Array): Uint8Array => new Uint8Array(stored.buffer, stored.byteOffset, stored.byteLength);
export const blobToVector = (blob: Uint8Array): Int8Array => new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);

export interface VectorMatch {
  id: number;
  /** Cosine similarity to the query, -1 to 1. */
  similarity: number;
}

export interface VectorSearchResult {
  /** Best first. */
  matches: VectorMatch[];
  /**
   * Median similarity of the query to the vectors searched: what "unrelated"
   * scores for this query and model. Null when there are too few to tell.
   */
  background: number | null;
}

export interface VectorSearchOptions {
  limit?: number;
  /** Leave out matches below this similarity. */
  minSimilarity?: number;
  /** Only consider these ids (e.g. the chunks an agent may see). */
  allow?: (id: number) => boolean;
  /** Vectors needed before `background` is reported. */
  minForBackground?: number;
}

export class VectorIndex {
  private ids: number[] = [];
  private data: Int8Array;
  private count = 0;

  constructor(readonly dimensions: number, capacity = 64) {
    this.data = new Int8Array(Math.max(1, capacity) * dimensions);
  }

  get size(): number {
    return this.count;
  }

  /** Add a stored vector. Returns false (and adds nothing) if it is the wrong size. */
  add(id: number, stored: Int8Array): boolean {
    if (stored.length !== this.dimensions) return false;
    if ((this.count + 1) * this.dimensions > this.data.length) {
      const grown = new Int8Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set(stored, this.count * this.dimensions);
    this.ids.push(id);
    this.count++;
    return true;
  }

  /** The vectors most similar to `query` (any length; it is normalised here). */
  search(query: ArrayLike<number>, opts: VectorSearchOptions = {}): VectorSearchResult {
    if (query.length !== this.dimensions || this.count === 0) return { matches: [], background: null };
    const limit = opts.limit ?? 10;
    const floor = opts.minSimilarity ?? -Infinity;
    const q = normalise(query);
    const { data, dimensions, ids, count } = this;
    const scores = new Float32Array(count);
    let considered = 0;
    for (let i = 0; i < count; i++) {
      if (opts.allow && !opts.allow(ids[i])) {
        scores[i] = NaN;
        continue;
      }
      let dot = 0;
      const offset = i * dimensions;
      for (let j = 0; j < dimensions; j++) dot += data[offset + j] * q[j];
      scores[i] = dot / SCALE;
      considered++;
    }

    const matches: VectorMatch[] = [];
    for (let i = 0; i < count; i++) {
      const similarity = scores[i];
      if (Number.isNaN(similarity) || similarity < floor) continue;
      matches.push({ id: ids[i], similarity });
    }
    matches.sort((a, b) => b.similarity - a.similarity);

    let background: number | null = null;
    if (considered >= (opts.minForBackground ?? 5)) {
      // A large index is sampled evenly; the median of a couple of thousand scores is steady enough.
      const step = Math.max(1, Math.floor(count / BACKGROUND_SAMPLE));
      const sample: number[] = [];
      for (let i = 0; i < count; i += step) if (!Number.isNaN(scores[i])) sample.push(scores[i]);
      sample.sort((a, b) => a - b);
      const mid = sample.length >> 1;
      if (sample.length > 0) background = sample.length % 2 ? sample[mid] : (sample[mid - 1] + sample[mid]) / 2;
    }
    return { matches: matches.slice(0, limit), background };
  }
}

/**
 * Whether a similarity is high enough to act on without being asked. Raw
 * cosine similarity means different things per embedding model, so the main
 * test is how far the match stands out from the background.
 */
export function standsOut(
  similarity: number,
  background: number | null,
  opts: { margin?: number; minWithoutBackground?: number } = {},
): boolean {
  if (background === null) return similarity >= (opts.minWithoutBackground ?? 0.5);
  return similarity - background >= (opts.margin ?? 0.08);
}
