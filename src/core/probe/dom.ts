import { inferCandidates, type Candidate } from '@/src/picker/infer';

/**
 * Mencari daftar item di seluruh dokumen tanpa user menunjuk apa pun.
 *
 * Dipakai hanya sebagai fallback: kalau situs menyediakan JSON, JSON menang.
 * Prefilter tag yang berulang menjaga biaya tetap wajar di halaman besar.
 */

const MAX_SCANNED_CONTAINERS = 1_200;
const MAX_CHILDREN = 400;

export function findDomList(doc: Document): Candidate | null {
  const body = doc.body;
  if (!body) return null;

  let best: Candidate | null = null;
  let scanned = 0;

  for (const parent of Array.from(body.querySelectorAll('*'))) {
    if (scanned >= MAX_SCANNED_CONTAINERS) break;

    const children = Array.from(parent.children);
    if (children.length < 3 || children.length > MAX_CHILDREN) continue;

    const tagCounts = new Map<string, number>();
    for (const child of children) {
      tagCounts.set(child.tagName, (tagCounts.get(child.tagName) ?? 0) + 1);
    }
    if (Math.max(...tagCounts.values()) < 3) continue;

    scanned += 1;
    const first = children[0];
    if (!first) continue;

    const { candidates } = inferCandidates(first, { layout: false, maxDepth: 2 });
    const match = candidates.find((candidate) => candidate.container === parent);
    if (!match) continue;

    if (!best || match.score > best.score) best = match;
  }

  return best;
}
