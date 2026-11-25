// crew#1563: the pure half of scripts/generate-voice-locks.mjs's size lines: which wheel pip picks on a target, the
// `# wheel:` / `# engine-bytes:` lines of a lock, and the rewrite that adds them with every requirement line kept
// byte for byte. No network and no process here (the generator feeds it pip's tag order and PyPI's release JSON), so
// tests drive it offline.

/**
 * A wheel's build tag as pip orders it: `()` when there is none, else `[number prefix, rest]` (PEP 427: the build tag
 * starts with a digit; pip compares the numeric prefix, then the rest).
 * @param {string} tag
 * @returns {[number, string] | []}
 */
export function buildKey(tag) {
  if (tag === '') return [];
  const m = /^(\d+)(.*)$/.exec(tag);
  return m === null ? [0, tag] : [Number(m[1]), m[2] ?? ''];
}

/** @param {[number, string] | []} a @param {[number, string] | []} b */
function buildCompare(a, b) {
  if (a.length === 0 || b.length === 0) return a.length - b.length;
  return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
}

/**
 * The wheel pip picks among one release's wheels: the best (lowest) rank of any tag its file name carries (a tag
 * triple may be compressed: `py2.py3-none-any`), then the higher build tag (pip's candidate key). `null` when no wheel
 * is compatible.
 * @param {Array<{ file: string, bytes: number, sha256: string }>} wheels
 * @param {Map<string, number>} rank pip's compatible tags for the target, best first (0 is best)
 */
export function pickWheel(wheels, rank) {
  let best = null;
  for (const w of wheels) {
    const parts = w.file.replace(/\.whl$/, '').split('-');
    if (parts.length !== 5 && parts.length !== 6) continue;
    const [py, abi, plat] = parts.slice(-3);
    const build = buildKey(parts.length === 6 ? parts[2] : '');
    let score = Infinity;
    for (const a of py.split('.')) for (const b of abi.split('.')) for (const c of plat.split('.')) score = Math.min(score, rank.get(`${a}-${b}-${c}`) ?? Infinity);
    if (score === Infinity) continue;
    if (best === null || score < best.score || (score === best.score && buildCompare(build, best.build) > 0)) best = { ...w, score, build };
  }
  return best === null ? null : { file: best.file, bytes: best.bytes, sha256: best.sha256 };
}

/**
 * name, version and hashes of each requirement in a lock's text.
 * @param {string} text
 */
export function readPins(text) {
  return text.replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).map((l) => {
    const [req, ...rest] = l.split(/ +/);
    const [name, version] = (req ?? '').split('==');
    return { name: name ?? '', version: version ?? '', hashes: rest.filter((x) => x.startsWith('--hash=sha256:')).map((x) => x.slice('--hash=sha256:'.length)) };
  });
}

/**
 * The size lines for a lock's pins: the wheel pip picks for each, which must be one the lock already holds the hash
 * of (else this throws, and nothing is written), and their total.
 * @param {Map<string, number>} rank
 * @param {ReturnType<typeof readPins>} pins
 * @param {(name: string, version: string) => Promise<Array<{ file: string, bytes: number, sha256: string }>>} wheelsOf
 */
export async function sizeLines(rank, pins, wheelsOf) {
  const lines = [];
  let total = 0;
  for (const p of pins) {
    const w = pickWheel(await wheelsOf(p.name, p.version), rank);
    if (w === null) throw new Error(`${p.name}==${p.version} has no wheel for this target`);
    if (!p.hashes.includes(w.sha256)) throw new Error(`${w.file}: its sha256 is not in the lock`);
    lines.push(`# wheel: ${w.file} ${w.bytes}\n`);
    total += w.bytes;
  }
  return `${lines.join('')}# engine-bytes: ${total}\n`;
}

/**
 * A lock with fresh size lines: the header, the size lines, then every requirement line exactly as it was.
 * @param {string} text the lock as committed
 * @param {string} header the generator's header line (with its newline)
 * @param {string} sizes {@link sizeLines}'s answer
 */
export function withSizes(text, header, sizes) {
  const body = text.split('\n').filter((l) => !l.startsWith('#')).join('\n').replace(/^\n+/, '');
  return `${header}${sizes}${body}`;
}
