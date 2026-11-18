// Generates web/assets/rfw.svg — a stand-in for the designer's 'RFW' multi-line lettering
// (poster key visual). Each letter is one or more families of K lines interpolated between
// an "outer" contour and an "inner" contour with the same corner structure, drawn as
// rounded polylines (L + A commands). Replace with the designer's SVG when it arrives.
// Usage: node tools/gen-rfw.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1100, H = 250;
const r1 = (n) => Math.round(n * 10) / 10;

// A family: outer/inner are arrays of [x, y, cornerRadius]; must have equal length.
// k lines; t=0 → outer contour, t=1 → inner contour. Families are grouped per letter;
// each letter gets its own green→cyan→blue gradient (as on the poster).
const letters = [
  {
    id: 'r', x0: 12, x1: 342,
    families: [
      // R : stem + bowl, folding at the waist (nested V turns along a diagonal seam) into the leg
      {
        k: 18,
        outer: [[12, 246, 0], [12, 6, 22], [338, 6, 78], [338, 190, 40], [256, 190, 3], [342, 246, 0]],
        inner: [[138, 246, 0], [138, 104, 10], [228, 104, 26], [228, 136, 12], [158, 136, 3], [186, 246, 0]],
      },
    ],
  },
  {
    id: 'f', x0: 372, x1: 680,
    families: [
      // F : stem + top bar (lines fan off the stem near the top-left)
      {
        k: 13,
        outer: [[372, 246, 0], [372, 6, 22], [520, 6, 0], [680, 6, 0]],
        inner: [[426, 246, 0], [426, 44, 18], [534, 104, 22], [680, 104, 0]],
      },
      // F : middle bar as a U (up the stem, out to the right, back, down)
      {
        k: 10,
        outer: [[440, 246, 0], [440, 120, 20], [668, 120, 24], [668, 206, 24], [528, 206, 14], [528, 246, 0]],
        inner: [[484, 246, 0], [484, 158, 8], [632, 158, 8], [632, 170, 8], [498, 170, 6], [498, 246, 0]],
      },
    ],
  },
  {
    id: 'w', x0: 704, x1: 1096,
    families: [
      // W : left arm — horizontal lines turning into diagonals that fan toward the left vertex
      {
        k: 17,
        outer: [[704, 6, 0], [818, 6, 6], [890, 246, 0]],
        inner: [[756, 246, 0], [846, 246, 2], [850, 246, 0]],
      },
      // W : middle peak
      {
        k: 12,
        outer: [[856, 246, 0], [872, 6, 10], [928, 6, 10], [944, 246, 0]],
        inner: [[884, 246, 0], [899, 120, 4], [901, 120, 4], [916, 246, 0]],
      },
      // W : right arm (mirror of left arm)
      {
        k: 17,
        outer: [[1096, 6, 0], [982, 6, 6], [910, 246, 0]],
        inner: [[1044, 246, 0], [954, 246, 2], [950, 246, 0]],
      },
    ],
  },
];

const SW_OUT = 2.5, SW_IN = 1.5; // stroke width: outer lines heavier, inner lines finer

function roundedPath(pts) {
  // pts: [[x,y,r], ...] → SVG path d with fillet arcs at interior corners
  const n = pts.length;
  const seg = (i) => Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  // desired tangent length per corner
  const tan = pts.map((p, i) => {
    if (i === 0 || i === n - 1 || p[2] < 0.05) return { t: 0, th: 0 };
    const [ax, ay] = pts[i - 1], [bx, by] = p, [cx, cy] = pts[i + 1];
    const l1 = Math.hypot(ax - bx, ay - by), l2 = Math.hypot(cx - bx, cy - by);
    if (l1 < 0.01 || l2 < 0.01) return { t: 0, th: 0 };
    const cos = Math.max(-1, Math.min(1, ((ax - bx) * (cx - bx) + (ay - by) * (cy - by)) / (l1 * l2)));
    const th = Math.acos(cos);
    if (Math.PI - th < 0.01) return { t: 0, th: 0 };
    return { t: p[2] / Math.tan(th / 2), th };
  });
  // shrink so neighbouring fillets never overlap on a segment
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n - 1; i++) {
      const L = seg(i), s = tan[i].t + tan[i + 1].t;
      if (s > L && s > 0) { const k = L / s; tan[i].t *= k; tan[i + 1].t *= k; }
    }
  }
  let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 1; i < n - 1; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const { t, th } = tan[i];
    if (t < 0.05) { d += ` L${r1(bx)} ${r1(by)}`; continue; }
    const l1 = Math.hypot(ax - bx, ay - by), l2 = Math.hypot(cx - bx, cy - by);
    const u1x = (ax - bx) / l1, u1y = (ay - by) / l1, u2x = (cx - bx) / l2, u2y = (cy - by) / l2;
    const re = t * Math.tan(th / 2);
    const p1x = bx + u1x * t, p1y = by + u1y * t, p2x = bx + u2x * t, p2y = by + u2y * t;
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    const sweep = cross > 0 ? 1 : 0; // clockwise on screen (y-down) → sweep 1
    d += ` L${r1(p1x)} ${r1(p1y)} A${r1(re)} ${r1(re)} 0 0 ${sweep} ${r1(p2x)} ${r1(p2y)}`;
  }
  const last = pts[n - 1];
  d += ` L${r1(last[0])} ${r1(last[1])}`;
  // drop L commands that duplicate the following point
  return d.replace(/ L(\S+) (\S+)(?= L\1 \2)/g, '');
}

let idx = 0;
const groups = [];
const grads = [];
for (const L of letters) {
  const paths = [];
  for (const f of L.families) {
    for (let j = 0; j < f.k; j++) {
      const t = f.k === 1 ? 0 : j / (f.k - 1);
      const pts = f.outer.map((o, n) => {
        const q = f.inner[n];
        return [o[0] + (q[0] - o[0]) * t, o[1] + (q[1] - o[1]) * t, o[2] + (q[2] - o[2]) * t];
      });
      const sw = SW_OUT + (SW_IN - SW_OUT) * t;
      paths.push(`<path class="rfw-line" style="--i:${idx++}" pathLength="1" stroke-width="${r1(sw)}" d="${roundedPath(pts)}"/>`);
    }
  }
  // slight diagonal: bottom-left → top-right across the letter
  grads.push(`<linearGradient id="rfw-grad-${L.id}" gradientUnits="userSpaceOnUse" x1="${L.x0}" y1="${H * 0.8}" x2="${L.x1}" y2="${H * 0.2}">
<stop offset="0" stop-color="#1FB37A"/>
<stop offset="0.6" stop-color="#00B4F0"/>
<stop offset="1" stop-color="#1E8FE0"/>
</linearGradient>`);
  groups.push(`<g stroke="url(#rfw-grad-${L.id})">\n${paths.join('\n')}\n</g>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="rfw-title" preserveAspectRatio="xMidYMid meet">
<title id="rfw-title">RFW</title>
<defs>
${grads.join('\n')}
</defs>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
${groups.join('\n')}
</g>
</svg>
`;

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../web/assets/rfw.svg');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg);
console.log(`wrote ${out}: ${idx} lines, ${svg.length} bytes`);
