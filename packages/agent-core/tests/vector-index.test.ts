import { describe, expect, test } from "bun:test";
import { cosineSimilarity } from "../src/embeddings/index.js";
import { VectorIndex, blobToVector, normalise, quantise, standsOut, vectorToBlob } from "../src/embeddings/vector-index.js";

/** Repeatable pseudo-random vectors, so the comparison with exact cosine is stable. */
function vector(seed: number, dimensions = 64): number[] {
  let state = seed * 2654435761;
  return Array.from({ length: dimensions }, () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  });
}

describe("vector index", () => {
  test("stores one byte per dimension and survives a round trip through a blob", () => {
    const stored = quantise([3, 4, 0, 0]);
    expect([...stored]).toEqual([76, 102, 0, 0]);
    expect(stored.byteLength).toBe(4);
    expect([...blobToVector(vectorToBlob(stored))]).toEqual([...stored]);
    expect([...normalise([0, 0])]).toEqual([0, 0]);
  });

  test("similarity matches exact cosine closely, and ranking matches exactly at the top", () => {
    const index = new VectorIndex(64, 2);
    const docs = Array.from({ length: 300 }, (_, i) => vector(i + 1));
    docs.forEach((doc, i) => expect(index.add(i, quantise(doc))).toBe(true));
    expect(index.size).toBe(300);

    const query = vector(9999);
    const exact = docs.map((doc, id) => ({ id, similarity: cosineSimilarity(query, doc) })).sort((a, b) => b.similarity - a.similarity);
    const { matches, background } = index.search(query, { limit: 300 });
    for (const match of matches) expect(Math.abs(match.similarity - exact.find((e) => e.id === match.id)!.similarity)).toBeLessThan(0.02);
    expect(matches.slice(0, 5).map((m) => m.id)).toEqual(exact.slice(0, 5).map((e) => e.id));
    expect(Math.abs(background! - exact[150].similarity)).toBeLessThan(0.03);
  });

  test("an identical vector scores 1, an opposite one -1, an unrelated one 0", () => {
    const index = new VectorIndex(4);
    index.add(1, quantise([1, 0, 0, 0]));
    index.add(2, quantise([-1, 0, 0, 0]));
    index.add(3, quantise([0, 1, 0, 0]));
    const { matches, background } = index.search([5, 0, 0, 0]);
    expect(matches).toEqual([{ id: 1, similarity: 1 }, { id: 3, similarity: 0 }, { id: 2, similarity: -1 }]);
    // Too few vectors to say what "unrelated" looks like.
    expect(background).toBeNull();
  });

  test("limit, floor and allow-list narrow the result; wrong-sized vectors are refused", () => {
    const index = new VectorIndex(4);
    for (let i = 1; i <= 6; i++) index.add(i, quantise([1, i / 10, 0, 0]));
    expect(index.add(7, quantise([1, 0, 0]))).toBe(false);
    expect(index.search([1, 0, 0, 0], { limit: 2 }).matches.map((m) => m.id)).toEqual([1, 2]);
    expect(index.search([1, 0, 0, 0], { minSimilarity: 0.95 }).matches.map((m) => m.id)).toEqual([1, 2, 3]);
    const even = index.search([1, 0, 0, 0], { allow: (id) => id % 2 === 0 });
    expect(even.matches.map((m) => m.id)).toEqual([2, 4, 6]);
    // Only three were considered, so no background level.
    expect(even.background).toBeNull();
    expect(index.search([1, 0, 0], {}).matches).toEqual([]);
  });

  test("standing out is judged against the background, or a fixed bar when there is none", () => {
    expect(standsOut(0.55, 0.45)).toBe(true);
    expect(standsOut(0.5, 0.45)).toBe(false);
    expect(standsOut(0.5, null)).toBe(true);
    expect(standsOut(0.49, null)).toBe(false);
    expect(standsOut(0.4, null, { minWithoutBackground: 0.35 })).toBe(true);
  });
});
