// Lab solver variants for sokoban-solver-01 — written from scratch in this lab.
// Algorithm family (from the kit's public description, reimplemented here):
//   * levels split into independent rooms (roomsOf: cut dead hallway squares);
//   * each room solved over PUSH-macro states: (sorted box squares, player region id);
//   * pruning: dead squares (pull-back from goals) + frozen 2x2 blocks.
// Variants differ only in the per-room search order:
//   BFS  : breadth-first over pushes (optimal by construction, reference-style).
//   ASTAR: A* over pushes, h = min-cost assignment of single-box push-distances
//          (push-distance ignores other boxes; admissible + consistent, so optimal).
//   ASTAR_MANH: A* with Manhattan-assignment h (cheap, admissible, weaker).
//   GREEDY: best-first on h alone (not optimal; fallback ladder rung).
// No clock, no randomness anywhere: budgets are counted in expanded states.

export const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

export function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares a lone box can be pushed from onto some goal (pull-back from goals).
export function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y >= 0 && y < wall.length && !wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Flood-fill the player's region from `from` with `occupied` boxes as walls.
// Marks cells in `seen` with `stamp`; returns the region's lowest square.
export function reachLow(level, occupied, from, seen, stamp, stack) {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    // neighbours: up/down/left/right, guarding the left/right board edges
    const x = p % w;
    if (p - w >= 0 && wall[p - w] === 0 && occupied[p - w] === 0 && seen[p - w] !== stamp) { seen[p - w] = stamp; stack[n++] = p - w; }
    if (p + w < wall.length && wall[p + w] === 0 && occupied[p + w] === 0 && seen[p + w] !== stamp) { seen[p + w] = stamp; stack[n++] = p + w; }
    if (x > 0 && wall[p - 1] === 0 && occupied[p - 1] === 0 && seen[p - 1] !== stamp) { seen[p - 1] = stamp; stack[n++] = p - 1; }
    if (x < w - 1 && wall[p + 1] === 0 && occupied[p + 1] === 0 && seen[p + 1] !== stamp) { seen[p + 1] = stamp; stack[n++] = p + 1; }
  }
  return low;
}

function frozenBlock(level, occupied, goal, t) {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1, c = a + w, d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// Shortest walk (lower-case LURD) from `from` to `to` avoiding walls + boxes.
export function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square unreachable');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

export function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q >= 0 && q < wall.length && !wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// --- Heuristics ------------------------------------------------------------
// Min-cost assignment over permutations (n <= 4 -> at most 24 permutations).
function minAssignment(cost) {
  const n = cost.length;
  const perm = [...Array(n).keys()];
  let best = Infinity;
  const rec = (i, used, sum) => {
    if (sum >= best) return;
    if (i === n) { best = sum; return; }
    for (let j = 0; j < n; j++) {
      if (used & (1 << j)) continue;
      const c = cost[i][j];
      if (!Number.isFinite(c)) continue;
      rec(i + 1, used | (1 << j), sum + c);
    }
  };
  rec(0, 0, 0);
  return best;
}

// Single-box push-distance table: for EVERY live floor square `s` (a box may be
// pushed onto any of them) and every goal `g`, the min pushes to move ONE box
// from `s` to `g`, ignoring other boxes, minimised over every player region
// (a box can split the floor, so the min must range over regions, not one).
// BFS over (box square, player-region low) with the lone box as the only obstacle.
export function pushDistTable(level) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const live = liveSquares(level);
  const table = new Map(); // key `${box}@${goal}` -> pushes (Infinity if unreachable)
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // The initial player regions for each start square: flood from EVERY floor
  // square with a box placed there, collecting each distinct region (a box can
  // split the floor). The BFS is seeded from ALL regions at distance 0, so the
  // table holds the min over player regions — a true lower bound no matter
  // where the player actually stands (a single start region would overestimate
  // whenever the box shuts the player out of the room, e.g. a box in the door).
  for (let start = 0; start < size; start++) {
    if (wall[start] || !live[start]) continue;
    occupied[start] = 1;
    const regionLows = [];
    {
      const seenR = new Int32Array(size);
      let markR = 0;
      for (let s = 0; s < size; s++) {
        if (wall[s] || occupied[s] || seenR[s]) continue;
        const low = reachLow(level, occupied, s, seenR, ++markR, stack);
        regionLows.push(low);
      }
    }
    occupied[start] = 0;
    // BFS from (start, low) for every region low, all at distance 0.
    const dist = new Map();
    const q = [];
    for (const low of regionLows) {
      const key = start * size + low;
      if (!dist.has(key)) { dist.set(key, 0); q.push([start, low, 0]); }
    }
    const bestTo = new Map(); // goal square -> min pushes
    for (let qi = 0; qi < q.length; qi++) {
      const [b, low, d] = q[qi];
      // region squares: recompute region of `low` with only box b as obstacle.
      // We need the actual region membership to test push reachability; recompute
      // the region set by flooding from the player square that produced `low`.
      // Instead of storing the square, store region via flood from a representative:
      // the state keeps `low`; flood from `low` itself (low is a floor square in
      // the region, and flooding from it with box b as obstacle gives the region).
      occupied[b] = 1;
      const regionMark = ++stamp;
      reachLow(level, occupied, low, seen, regionMark, stack);
      occupied[b] = 0;
      if (goals.includes(b) && !bestTo.has(b)) bestTo.set(b, d);
      for (const [dx, dy] of DIRS) {
        const dd = dy * w + dx;
        const t = b + dd;
        const behind = b - dd;
        if (t < 0 || t >= size || wall[t] || behind < 0 || behind >= size || wall[behind]) continue;
        if (seen[behind] !== regionMark) continue; // player cannot stand behind the box
        occupied[t] = 1;
        const nlow = reachLow(level, occupied, b, mark, ++stamp, stack);
        occupied[t] = 0;
        const key = t * size + nlow;
        if (!dist.has(key)) {
          dist.set(key, d + 1);
          q.push([t, nlow, d + 1]);
        }
      }
    }
    for (const g of goals) table.set(`${start}@${g}`, bestTo.has(g) ? bestTo.get(g) : Infinity);
  }

  return table;
}

// Manhattan-assignment heuristic (cheap).
function manhHeuristic(level, boxes) {
  const { w, goals } = level;
  const cost = boxes.map((b) => goals.map((g) => Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w))));
  return minAssignment(cost);
}

// Push-distance-assignment heuristic; `table` from pushDistTable(level).
function pushHeuristic(level, boxes, table) {
  const { goals } = level;
  const cost = boxes.map((b) => goals.map((g) => table.get(`${b}@${g}`) ?? Infinity));
  return minAssignment(cost);
}

// --- Per-room push search --------------------------------------------------
// mode: 'bfs' | 'astar' | 'astar_manh' | 'greedy'
// Returns { pushes, moves, expanded, generated } or null on budget exhaustion.
// `stats` collects per-room expanded counts for the caller.
export function solveRoom(level, maxStates, mode, stats) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (boxes) => boxes.every((b) => goal[b]);

  // Heuristic setup (A* modes).
  let table = null;
  let h0 = 0;
  if (mode === 'astar') { table = pushDistTable(level); h0 = pushHeuristic(level, level.boxes, table); }
  else if (mode === 'astar_manh') { h0 = manhHeuristic(level, level.boxes); }
  else if (mode === 'greedy') { table = pushDistTable(level); h0 = pushHeuristic(level, level.boxes, table); }
  if ((mode === 'astar' || mode === 'greedy') && !Number.isFinite(h0)) return null;
  if (mode === 'astar_manh' && !Number.isFinite(h0)) return null;

  const hOf = (boxes) => {
    if (mode === 'bfs') return 0;
    if (mode === 'astar_manh') return manhHeuristic(level, boxes);
    return pushHeuristic(level, boxes, table);
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const keyOf = (boxes, low) => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // State store: boxes, player square, parent index, g (pushes), h.
  const sBoxes = [level.boxes];
  const sPlayer = [level.player];
  const sParent = [-1];
  const sG = [0];
  const sH = [h0];
  const index = new Map();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, reachLow(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // Binary heap ordered by (f, h, g, insertion) for A*; plain FIFO queue for BFS.
  // BFS uses a simple array queue; A*/greedy use the heap with f = g + h (greedy: f = h).
  const heap = [];
  const prio = (i) => {
    const g = sG[i], h = sH[i];
    return mode === 'greedy' ? h : g + h;
  };
  const less = (a, b) => {
    const fa = prio(a), fb = prio(b);
    if (fa !== fb) return fa < fb;
    if (sH[a] !== sH[b]) return sH[a] < sH[b];
    if (sG[a] !== sG[b]) return sG[a] > sG[b];
    return a < b;
  };
  const heapPush = (i) => {
    let n = heap.length;
    heap.push(i);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (!less(heap[n], heap[p])) break;
      [heap[n], heap[p]] = [heap[p], heap[n]];
      n = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  const queue = [0];
  let qhead = 0;

  let expanded = 0;
  let found = solved(level.boxes) ? 0 : -1;
  const takeNext = () => (mode === 'bfs' ? (qhead < queue.length ? queue[qhead++] : -1) : heap.length > 0 ? heapPop() : -1);
  if (mode !== 'bfs') heapPush(0);

  while (found < 0) {
    const cur = takeNext();
    if (cur < 0) break; // exhausted: no solution within the explored space
    // Skip stale heap entries (a better g for the same key was recorded).
    const boxes = sBoxes[cur];
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reachLow(level, occupied, sPlayer[cur], seen, here, stack);
    // Verify this state is still the recorded best for its key (A* reopening guard).
    const curKey = keyOf(boxes, reachLow(level, occupied, sPlayer[cur], mark, ++stamp, stack));
    if (index.get(curKey) !== cur) { for (const x of boxes) occupied[x] = 0; continue; }
    expanded++;
    if (expanded > maxStates) { for (const x of boxes) occupied[x] = 0; break; }
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size || seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next = null;
        let nh = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          nh = hOf(next);
          if (Number.isFinite(nh)) key = keyOf(next, reachLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || key < 0 || !Number.isFinite(nh)) continue;
        const prevIdx = index.get(key);
        const ng = sG[cur] + 1;
        if (prevIdx !== undefined && sG[prevIdx] <= ng) continue; // already have it as good or better
        if (sBoxes.length >= maxStates && prevIdx === undefined) {
          for (const x of boxes) occupied[x] = 0;
          if (stats) { stats.expanded = expanded; stats.generated = sBoxes.length; stats.exhausted = true; }
          return null;
        }
        const ni = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(cur);
        sG.push(ng);
        sH.push(nh);
        index.set(key, ni);
        if (mode === 'bfs') queue.push(ni);
        else heapPush(ni);
        if (solved(next)) { found = ni; break; }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (stats) { stats.expanded = expanded; stats.generated = sBoxes.length; stats.exhausted = found < 0; }
  if (found < 0) return null;
  // Reconstruct moves.
  const path = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = sBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b));
    const to = nextBoxes.find((b) => !boxes.includes(b));
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves, expanded, generated: sBoxes.length };
}

// Solve a whole level room by room. `budget` = max states per room search.
// `mode` selects the per-room search; on per-room exhaustion, `fallback` mode is
// tried for that room with its OWN budget `fallbackBudget` (default = budget),
// then whole-level search as a last resort.
// Returns { pushes, moves, rooms: [{pushes, expanded, generated, mode}], ok }.
export function solveLevel(level, budget, mode, fallback, roomStatsOut, fallbackBudget = budget) {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const st = {};
    const r = solveRoom(level, budget, mode, st);
    if (roomStatsOut) roomStatsOut.push({ ...st, mode, whole: true });
    return r ? { pushes: r.pushes, moves: r.moves, rooms: [{ pushes: r.pushes, expanded: r.expanded, generated: r.generated, mode }], ok: true } : { pushes: 0, moves: '', rooms: [], ok: false };
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const roomStats = [];
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms)
      if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    const sub = { w: level.w, h: level.h, wall, goals: room.goals.slice().sort((a, b) => a - b), boxes: room.boxes.slice().sort((a, b) => a - b), player };
    let usedMode = mode;
    let st = {};
    let solved = solveRoom(sub, budget, mode, st);
    if (solved === null && fallback && fallback !== mode) {
      usedMode = fallback;
      st = {};
      solved = solveRoom(sub, fallbackBudget, fallback, st);
    }
    roomStats.push({ pushes: solved ? solved.pushes : -1, expanded: st.expanded ?? 0, generated: st.generated ?? 0, mode: usedMode, exhausted: st.exhausted ?? true });
    if (solved === null) {
      if (roomStatsOut) roomStatsOut.push(...roomStats);
      return { pushes, moves, rooms: roomStats, ok: false };
    }
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  if (roomStatsOut) roomStatsOut.push(...roomStats);
  return { pushes, moves, rooms: roomStats, ok: true };
}
