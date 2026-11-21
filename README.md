# Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/oxizbinance-aox/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/oxizbinance-aox/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Entry for make.fun competition `sokoban-solver-01-run-20261121`: build the
best Sokoban solver. The program answers all 5 instances of a set in one
run, writing each level's moves (XSB `u/d/l/r`, upper letter = a push) to
`solution.txt`, in as few pushes as it can.

## How it works

The levels are a hallway with independent rooms off it (3–4 boxes each),
and the level's push-optimum is the sum of its rooms' optima — so each
room is solved on its own, push-optimally, and the moves are joined by the
player's walk along the hallway. A box pushed out of a room into the
hallway can never come back, so a room's search never needs the other
rooms' boxes (they stand as walls).

Per room the search is A\* over pushes: a state is the boxes plus the
player's reachable region (named by its lowest square). The heuristic is
the cheapest assignment of boxes to goals by exact single-box push
distances (admissible: one push moves one box one square, so it can cut
the assignment cost by at most one). Deadlocks pruned: dead squares (no
push route to any goal) and frozen 2×2 blocks of walls and boxes. If A\*
runs out of its work budget, a breadth-first search over pushes takes
over, then a greedy best-first search as a last resort. Every budget
counts work, never the clock, so two runs answer byte for byte alike.

## Run

```sh
node main.ts
```

Reads `$MAKEFUN_INPUT_DIR/<id>/level.txt` (else `/input`) and writes
`$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` (else `/output`).

Node 22, standard library only, deterministic (two runs byte-identical),
whole set solved in ~0.3 s.

## Verification

- Practice set (kit's `grade-local`): **score 1,000,000** — all 5 levels
  solved in exactly P\* pushes (13, 16, 29, 47, 60), passed 5/5,
  two executions reproduced byte for byte.
- 10 extra sets drawn with the kit's own generator from random seeds:
  **10/10 scored 1,000,000**, every level at exactly P\* pushes
  (solve times 241–723 ms per set).

## License

MIT — see [LICENSE](LICENSE).
