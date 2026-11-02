/**
 * Inferensi "pick set": dari satu elemen yang ditunjuk kursor, cari level
 * ancestor yang anak-anaknya membentuk daftar item berulang.
 *
 * Murni DOM, tanpa layout wajib (opsi `layout: false` dipakai di test jsdom).
 */

const IGNORED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'LINK',
  'META',
  'BR',
]);

const MAX_SHAPE_DEPTH = 2;
const SIMILARITY_THRESHOLD = 0.72;
const MIN_COVERAGE = 0.6;

export interface Candidate {
  /** Induk dari item-item (bukan item itu sendiri). */
  container: Element;
  items: Element[];
  /** Jarak dari elemen yang di-hover, 0 = paling dalam. */
  depth: number;
  /** Porsi anak container yang masuk grup ini, 0..1. */
  coverage: number;
  score: number;
}

export interface InferOptions {
  /** Set false di lingkungan tanpa layout (jsdom) supaya cek ukuran dilewati. */
  layout?: boolean;
  maxDepth?: number;
  minItems?: number;
}

export interface InferResult {
  /** Diurutkan dari set paling luar ke paling dalam, untuk `[` / `]`. */
  candidates: Candidate[];
  best: Candidate | null;
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Elemen UI ekstensi kita sendiri tidak boleh ikut jadi kandidat. */
function isOwnUi(el: Element): boolean {
  return el.closest('[data-scrapergod-ui]') !== null;
}

function isVisible(el: Element, layout: boolean): boolean {
  if (!layout) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return false;
  const style = getComputedStyle(el);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
}

/**
 * "Shape" = multiset tag turunan sampai kedalaman 2. Teks dan class sengaja
 * diabaikan supaya item dengan judul 1 baris vs 3 baris tetap dianggap sama,
 * dan rename class tidak merusak deteksi.
 */
function shapeOf(el: Element): Map<string, number> {
  const shape = new Map<string, number>();
  const walk = (node: Element, depth: number) => {
    if (depth > MAX_SHAPE_DEPTH) return;
    const tag = node.tagName;
    if (!IGNORED_TAGS.has(tag)) {
      shape.set(tag, (shape.get(tag) ?? 0) + 1);
    }
    if (depth === MAX_SHAPE_DEPTH) return;
    for (const child of Array.from(node.children)) walk(child, depth + 1);
  };
  walk(el, 0);
  return shape;
}

function similarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const keys = new Set([...a.keys(), ...b.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const x = a.get(key) ?? 0;
    const y = b.get(key) ?? 0;
    intersection += Math.min(x, y);
    union += Math.max(x, y);
  }
  return union === 0 ? 0 : intersection / union;
}

/**
 * Greedy clustering: item masuk klaster pertama yang representatifnya cukup
 * mirip. Ini yang membuat kartu iklan (struktur beda) terpisah dari kartu job.
 */
function clusterByShape(items: Element[]): Element[][] {
  const shapes = items.map(shapeOf);
  const clusters: { rep: Map<string, number>; items: Element[] }[] = [];

  for (let i = 0; i < items.length; i++) {
    const shape = shapes[i]!;
    let bestIndex = -1;
    let bestSimilarity = 0;
    for (let c = 0; c < clusters.length; c++) {
      const sim = similarity(clusters[c]!.rep, shape);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestIndex = c;
      }
    }
    if (bestIndex >= 0 && bestSimilarity >= SIMILARITY_THRESHOLD) {
      clusters[bestIndex]!.items.push(items[i]!);
    } else {
      clusters.push({ rep: shape, items: [items[i]!] });
    }
  }

  return clusters.map((c) => c.items);
}

function scoreOf(
  items: Element[],
  coverage: number,
  depth: number,
): number {
  const texts = items.map(textOf).filter(Boolean);
  const averageText =
    texts.reduce((sum, text) => sum + text.length, 0) /
    Math.max(1, texts.length);
  const linkRatio =
    items.filter((item) => item.querySelector('a[href]')).length / items.length;

  return (
    coverage * 3 +
    Math.log2(items.length + 1) +
    Math.min(averageText, 160) / 80 +
    linkRatio -
    depth * 0.08
  );
}

export function inferCandidates(
  hovered: Element,
  options: InferOptions = {},
): InferResult {
  const { layout = true, maxDepth = 8, minItems = 3 } = options;
  const found: Candidate[] = [];

  let node: Element | null = hovered;
  for (let depth = 0; depth < maxDepth && node; depth++) {
    const container: Element | null = node.parentElement;
    if (!container) break;

    const children = Array.from(container.children).filter(
      (child) => !isOwnUi(child) && isVisible(child, layout),
    );

    if (children.length >= minItems) {
      const groups = clusterByShape(children);
      let bestGroup: Element[] = [];
      for (const group of groups) {
        if (group.length > bestGroup.length) bestGroup = group;
      }

      const coverage = bestGroup.length / children.length;
      const averageText =
        bestGroup.reduce((sum, item) => sum + textOf(item).length, 0) /
        Math.max(1, bestGroup.length);

      if (
        bestGroup.length >= minItems &&
        coverage >= MIN_COVERAGE &&
        averageText >= 4 &&
        averageText <= 4000
      ) {
        found.push({
          container,
          items: bestGroup,
          depth,
          coverage,
          score: scoreOf(bestGroup, coverage, depth),
        });
      }
    }

    node = container;
  }

  const candidates = found.sort((a, b) => a.depth - b.depth);
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.score > best.score) best = candidate;
  }

  return { candidates, best };
}
