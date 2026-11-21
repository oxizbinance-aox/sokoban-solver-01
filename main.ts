// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// The generator builds every level as a hallway one square wide with
// independent rooms off it (3 or 4 boxes each), and the level's push-optimum
// P* is the sum of its rooms' optima. So each room is solved on its own,
// push-optimally, and the moves are joined by the player's walk along the
// hallway. A box pushed out of a room into the hallway can never come back,
// so no room's search ever needs the others' boxes (they stand as walls).
//
// Per room the search is A* over pushes: a state is the boxes plus the
// player's reachable region (named by its lowest square). The heuristic is
// the cheapest assignment of boxes to goals by exact single-box push
// distances (admissible: one push moves one box one square, so it can cut
// the assignment cost by at most one). Deadlocks pruned: dead squares (no
// push route to any goal) and frozen 2x2 blocks of walls and boxes. If A*
// runs out of its work budget, a breadth-first search over pushes takes over
// (the rooms are small enough that it always finishes), then a greedy
// best-first search as a last resort. Every budget counts work, never the
// clock, so two runs answer byte for byte alike.
//
// Node 22, standard library only. Reads $MAKEFUN_INPUT_DIR/<id>/level.txt,
// writes $MAKEFUN_OUTPUT_DIR/<id>/solution.txt (XSB moves, u/d/l/r, an
// upper letter marking a push).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets: expansions / stored states, never the clock. */
const ASTAR_BUDGET = 150_000;
const BFS_BUDGET = 400_000;
const GREEDY_BUDGET = 150_000;
const STATE_CAP = 600_000;
const GLOBAL_BUDGET = 3_000_000;

let workUsed = 0;

/** Directions: [dx, dy, walk letter, push letter]. One fixed order. */
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
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
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * For each goal, the fewest pushes a lone box needs to reach it from every
 * square, by pulling backwards from the goal: a box at x could have been
 * pushed there from y = x - d when y and the square behind it (y - d, where
 * the player stands) are open floor. Unreachable squares stay -1. A square
 * is live when some goal reaches it.
 */
function pushDistances(level: Level): { dist: Int32Array[]; live: Uint8Array } {
  const { w, wall, goals } = level;
  const size = wall.length;
  const dist: Int32Array[] = [];
  const live = new Uint8Array(size);
  for (const g of goals) {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const step = dy * w + dx;
        const y = x - step;
        if (y < 0 || y >= size || d[y]! >= 0 || wall[y]! || wall[y - step]!) continue;
        d[y] = d[x]! + 1;
        queue.push(y);
      }
    }
    dist.push(d);
    for (let i = 0; i < size; i++) if (d[i]! >= 0) live[i] = 1;
  }
  return { dist, live };
}

/** Every ordering of 0..n-1, for the box-to-goal assignment. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const used = new Array<boolean>(n).fill(false);
  const cur: number[] = [];
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

/**
 * The heuristic: the cheapest assignment of boxes to goals by single-box
 * push distance (exact while the box count is small), else the sum of each
 * box's nearest-goal distance. Infinity when no assignment reaches every
 * goal: a dead state. Admissible either way.
 */
function makeHeuristic(dist: Int32Array[], nb: number, ng: number): (boxes: number[]) => number {
  const perms = nb <= 6 && nb === ng ? permutations(nb) : null;
  return (boxes: number[]): number => {
    if (perms !== null) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < nb; i++) {
          const d = dist[p[i]!]![boxes[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let g = 0; g < ng; g++) {
        const d = dist[g]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };
}

/**
 * The player's reachable region from `from` with `occupied` in the way:
 * marks `seen` with `stamp` and returns the region's lowest square, which
 * names the region. `from` itself counts even when it sits on a square
 * marked wall (a player left standing on a finished room's goal).
 */
function regionLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const q0 = p - w;
    if (wall[q0] === 0 && occupied[q0] === 0 && seen[q0] !== stamp) {
      seen[q0] = stamp;
      stack[n++] = q0;
    }
    const q1 = p + w;
    if (wall[q1] === 0 && occupied[q1] === 0 && seen[q1] !== stamp) {
      seen[q1] = stamp;
      stack[n++] = q1;
    }
    const q2 = p - 1;
    if (wall[q2] === 0 && occupied[q2] === 0 && seen[q2] !== stamp) {
      seen[q2] = stamp;
      stack[n++] = q2;
    }
    const q3 = p + 1;
    if (wall[q3] === 0 && occupied[q3] === 0 && seen[q3] !== stamp) {
      seen[q3] = stamp;
      stack[n++] = q3;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
 * and boxes with a box off its goal. No box in such a block can ever be
 * pushed again, so the state is dead when one of them is off its goal.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a]! || occupied[a]!) || !(wall[b]! || occupied[b]!) || !(wall[c]! || occupied[c]!) || !(wall[d]! || occupied[d]!)) continue;
    if ((occupied[a]! && !goal[a]!) || (occupied[b]! && !goal[b]!) || (occupied[c]! && !goal[c]!) || (occupied[d]! && !goal[d]!)) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, or null. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const { w, wall } = level;
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length || wall[q]! || occupied[q]! || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside). */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * A push search over `level`: 'astar' (f = pushes + heuristic, goal tested
 * on pop, so the first goal popped is push-optimal), 'bfs' (first goal
 * enqueued is push-optimal), or 'greedy' (best-first on the heuristic
 * alone, any solution, for partial credit when the optimal searches give
 * up). Returns null when the work budget runs out or the level is dead.
 */
function searchPushes(level: Level, mode: 'astar' | 'bfs' | 'greedy', budget: number): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const { dist, live } = pushDistances(level);
  const heuristic = makeHeuristic(dist, level.boxes.length, goals.length);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b] === 1);
  if (level.boxes.some((b) => !live[b])) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };
  if (heuristic(level.boxes) === Infinity) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states: boxes, the player's square, parent, and the push that made
  // the state from its parent (the box's old square and the direction).
  const sBoxes: number[][] = [level.boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const closed = new Set<number>();
  const index = new Map<string, number>();
  const keyOf = (boxes: number[], low: number): string => String.fromCharCode(low, ...boxes);

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = regionLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(keyOf(level.boxes, startLow), 0);

  // The open list: a binary heap on [f, h, seq, id] for astar/greedy, a
  // plain queue for bfs. Ties break by insertion order, so the search is
  // deterministic.
  const heap: number[][] = [];
  const heapLess = (a: number[], b: number[]): boolean =>
    a[0]! < b[0]! || (a[0]! === b[0]! && (a[1]! < b[1]! || (a[1]! === b[1]! && a[2]! < b[2]!)));
  const heapPush = (e: number[]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number[] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };
  const queue: number[] = [];
  let seq = 0;
  const h0 = heuristic(level.boxes);
  if (mode === 'bfs') queue.push(0);
  else heapPush([h0, h0, seq++, 0]);

  // Rebuild the move string of a solved state: walk the parent chain for
  // the pushes, then replay them, walking the player to each push square.
  const finish = (goalId: number): SearchResult | null => {
    occupied.fill(0);
    const pushes: { from: number; dir: number }[] = [];
    for (let s = goalId; s > 0; s = sParent[s]!) pushes.push({ from: sFrom[s]!, dir: sDir[s]! });
    pushes.reverse();
    let moves = '';
    let player = level.player;
    let boxes = level.boxes.slice();
    for (const p of pushes) {
      const [dx, dy, , pushLetter] = DIRS[p.dir]!;
      const step = dy * w + dx;
      for (const b of boxes) occupied[b] = 1;
      const walk = walkTo(level, occupied, player, p.from - step);
      for (const b of boxes) occupied[b] = 0;
      if (walk === null) return null;
      moves += walk + pushLetter;
      const at = boxes.indexOf(p.from);
      boxes[at] = p.from + step;
      boxes.sort((a, b) => a - b);
      player = p.from;
    }
    return { pushes: pushes.length, moves };
  };

  let expanded = 0;
  let head = 0;
  while (mode === 'bfs' ? head < queue.length : heap.length > 0) {
    if (expanded >= budget || workUsed >= GLOBAL_BUDGET) return null;
    const id = mode === 'bfs' ? queue[head++]! : heapPop()[3]!;
    if (closed.has(id)) continue;
    closed.add(id);
    const boxes = sBoxes[id]!;
    const g = sG[id]!;
    if (mode !== 'bfs' && solved(boxes)) {
      const done = finish(id);
      if (done !== null) return done;
      return null;
    }
    expanded++;
    workUsed++;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(level, occupied, sPlayer[id]!, seen, here, stack);
    for (let bi = 0; bi < boxes.length && expanded <= budget && workUsed < GLOBAL_BUDGET; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const step = dy * w + dx;
        const behind = b - step;
        const target = b + step;
        if (behind < 0 || behind >= size || target < 0 || target >= size) continue;
        if (seen[behind] !== here) continue;
        if (wall[target]! || occupied[target]!) continue;
        if (!live[target]!) continue;
        occupied[b] = 0;
        occupied[target] = 1;
        const frozen = frozenBlock(level, occupied, goalSet, target);
        let key = '';
        let h = Infinity;
        let nlow = -1;
        if (!frozen) {
          const next = boxes.slice();
          next[bi] = target;
          next.sort((a, bb) => a - bb);
          h = heuristic(next);
          if (h !== Infinity) {
            nlow = regionLow(level, occupied, b, mark, ++stamp, stack);
            key = keyOf(next, nlow);
          }
          if (h !== Infinity) {
            const prev = index.get(key);
            if (prev === undefined) {
              if (sBoxes.length >= STATE_CAP) {
                occupied[target] = 0;
                occupied[b] = 1;
                for (const x of boxes) occupied[x] = 0;
                return null;
              }
              const nid = sBoxes.length;
              index.set(key, nid);
              sBoxes.push(next);
              sPlayer.push(b);
              sParent.push(id);
              sFrom.push(b);
              sDir.push(di);
              sG.push(g + 1);
              if (mode === 'bfs') {
                if (solved(next)) {
                  const done = finish(nid);
                  for (const x of boxes) occupied[x] = 0;
                  return done;
                }
                queue.push(nid);
              } else {
                heapPush([mode === 'astar' ? g + 1 + h : h, h, seq++, nid]);
              }
            } else if (sG[prev]! > g + 1) {
              // A shorter path to a known state (cannot happen with a
              // consistent heuristic, kept for safety): re-open it.
              sG[prev] = g + 1;
              sParent[prev] = id;
              sFrom[prev] = b;
              sDir[prev] = di;
              sPlayer[prev] = b;
              closed.delete(prev);
              if (mode === 'bfs') queue.push(prev);
              else heapPush([mode === 'astar' ? g + 1 + h : h, h, seq++, prev]);
            }
          }
        }
        occupied[target] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

/** One room's push-optimal solution, with the fallbacks behind it. */
function solveRoom(level: Level): SearchResult | null {
  return (
    searchPushes(level, 'astar', ASTAR_BUDGET) ??
    searchPushes(level, 'bfs', BFS_BUDGET) ??
    searchPushes(level, 'greedy', GREEDY_BUDGET)
  );
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const { live } = pushDistances(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = rooms.length;
        squares.push(q);
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (part[b]! < 0) return null;
    rooms[part[b]!]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. Falls
 * back to a search over the whole level when the level is no set of rooms
 * or a room's search gives up.
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solveRoom(sub);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  // No rooms, or a room gave up: one search over the whole level.
  const whole = solveRoom(level);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(INPUT).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
