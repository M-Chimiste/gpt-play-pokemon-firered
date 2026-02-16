const { MARKDOWN_TILES } = require("../../constants/tiles");

const DIRECTIONS = [
  { key: "up", dx: 0, dy: -1 },
  { key: "down", dx: 0, dy: 1 },
  { key: "left", dx: -1, dy: 0 },
  { key: "right", dx: 1, dy: 0 },
];

const BLOCKED_ENTRY_BY_CODE = new Map([
  [68, new Set(["down"])],
  [69, new Set(["up"])],
  [70, new Set(["left"])],
  [71, new Set(["right"])],
  [72, new Set(["down", "left"])],
  [73, new Set(["down", "right"])],
  [74, new Set(["up", "left"])],
  [75, new Set(["up", "right"])],
]);

const LEDGE_DIRECTION_BY_CODE = new Map([
  [5, "right"],
  [6, "left"],
  [7, "up"],
  [8, "down"],
]);

const FORCED_DIRECTION_BY_CODE = new Map([
  [44, "left"],
  [45, "right"],
  [46, "up"],
  [47, "down"],
  [50, "left"],
  [51, "right"],
  [52, "up"],
  [53, "down"],
  [60, "right"],
  [61, "left"],
  [62, "up"],
  [63, "down"],
]);

const BLOCKED_CODES = new Set([
  0, // Wall
  10, // NPC
  11, // Interactive
  14, // PC
  15, // Region map
  16, // Television
  18, // Bookshelf
  21, // Trash can
  22, // Shop shelf
  25, // OOB collision
  33, // Boulder
  35, // Cuttable tree
  36, // Breakable rock
  55, // Item ball
  66, // Temporary wall
  67, // Locked door
]);

const WATER_CODES = new Set([3, 4, 50, 51, 52, 53, 54]);

const TRANSITION_CODES = new Set([
  9, // Warp
  26, // Door
  27, // Ladder
  28, // Escalator
  29, // Hole
  30, // Stairs
  31, // Entrance
  32, // Warp arrow
]);

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(node) {
    this.items.push(node);
    this.#bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return null;
    const min = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      this.#bubbleDown(0);
    }
    return min;
  }

  #bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  #bubbleDown(index) {
    const length = this.items.length;
    while (true) {
      let smallest = index;
      const left = index * 2 + 1;
      const right = index * 2 + 2;
      if (left < length && this.items[left].priority < this.items[smallest].priority) {
        smallest = left;
      }
      if (right < length && this.items[right].priority < this.items[smallest].priority) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
      index = smallest;
    }
  }
}

function normalizeMovementMode(mode) {
  const normalized = String(mode || "WALK").trim().toUpperCase();
  if (normalized === "SURF" || normalized === "DIVE") return normalized;
  if (normalized.includes("BIKE")) return "BIKE";
  return "WALK";
}

function isWaterAllowed(mode) {
  return mode === "SURF" || mode === "DIVE";
}

function inBounds(grid, x, y) {
  return y >= 0 && y < grid.length && x >= 0 && x < grid[0].length;
}

function getTileCode(grid, x, y) {
  const raw = grid?.[y]?.[x];
  if (raw == null) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function isPassableTile(code, mode, allowTransitions, isTarget) {
  if (code == null) return false;
  if (!Object.prototype.hasOwnProperty.call(MARKDOWN_TILES, code)) return false;
  if (BLOCKED_CODES.has(code)) return false;
  if (WATER_CODES.has(code) && !isWaterAllowed(mode)) return false;
  if (TRANSITION_CODES.has(code) && !(allowTransitions && isTarget)) return false;
  return true;
}

function isEntryBlocked(code, directionKey) {
  const blocked = BLOCKED_ENTRY_BY_CODE.get(code);
  return blocked ? blocked.has(directionKey) : false;
}

function attemptMove({ grid, from, dir, movementMode, allowTransitions, target }) {
  let x = from.x + dir.dx;
  let y = from.y + dir.dy;
  if (!inBounds(grid, x, y)) return null;

  let code = getTileCode(grid, x, y);
  const isTarget = target && x === target.x && y === target.y;
  if (!isPassableTile(code, movementMode, allowTransitions, isTarget)) return null;
  if (isEntryBlocked(code, dir.key)) return null;

  const ledgeDir = LEDGE_DIRECTION_BY_CODE.get(code);
  if (ledgeDir) {
    if (ledgeDir !== dir.key) return null;
    const jumpX = x + dir.dx;
    const jumpY = y + dir.dy;
    if (!inBounds(grid, jumpX, jumpY)) return null;
    const jumpCode = getTileCode(grid, jumpX, jumpY);
    const isJumpTarget = target && jumpX === target.x && jumpY === target.y;
    if (!isPassableTile(jumpCode, movementMode, allowTransitions, isJumpTarget)) return null;
    if (isEntryBlocked(jumpCode, dir.key)) return null;
    x = jumpX;
    y = jumpY;
    code = jumpCode;
  }

  const visited = new Set();
  while (true) {
    const forcedDirKey = FORCED_DIRECTION_BY_CODE.get(code);
    if (!forcedDirKey) break;
    const forcedDir = DIRECTIONS.find((d) => d.key === forcedDirKey);
    if (!forcedDir) break;
    const loopKey = `${x},${y},${forcedDirKey}`;
    if (visited.has(loopKey)) return null;
    visited.add(loopKey);
    const nextX = x + forcedDir.dx;
    const nextY = y + forcedDir.dy;
    if (!inBounds(grid, nextX, nextY)) return null;
    const nextCode = getTileCode(grid, nextX, nextY);
    const isNextTarget = target && nextX === target.x && nextY === target.y;
    if (!isPassableTile(nextCode, movementMode, allowTransitions, isNextTarget)) return null;
    if (isEntryBlocked(nextCode, forcedDir.key)) return null;
    x = nextX;
    y = nextY;
    code = nextCode;
  }

  return { x, y };
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function reconstructPath(cameFrom, startKey, goalKey) {
  if (startKey === goalKey) return [];
  const keys = [];
  let current = goalKey;
  while (current && current !== startKey) {
    const step = cameFrom.get(current);
    if (!step) break;
    keys.push(step.moveKey);
    current = step.prevKey;
  }
  return keys.reverse();
}

function parseKey(key) {
  const [x, y] = String(key).split(",").map((v) => Number(v));
  return { x, y };
}

function findLocalPath({ grid, start, target, movementMode }) {
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0])) {
    return {
      keys: [],
      reachedTarget: false,
      finalPosition: { ...start },
      explored: 0,
      reason: "invalid_grid",
    };
  }

  const mode = normalizeMovementMode(movementMode);
  const startKey = `${start.x},${start.y}`;
  const targetKey = `${target.x},${target.y}`;
  const allowTransitions = TRANSITION_CODES.has(getTileCode(grid, target.x, target.y));

  if (!inBounds(grid, start.x, start.y) || !inBounds(grid, target.x, target.y)) {
    return {
      keys: [],
      reachedTarget: false,
      finalPosition: { ...start },
      explored: 0,
      reason: "out_of_bounds",
    };
  }

  if (startKey === targetKey) {
    return {
      keys: [],
      reachedTarget: true,
      finalPosition: { ...start },
      explored: 0,
      reason: "already_at_target",
    };
  }

  const startCode = getTileCode(grid, start.x, start.y);
  if (!isPassableTile(startCode, mode, allowTransitions, true)) {
    return {
      keys: [],
      reachedTarget: false,
      finalPosition: { ...start },
      explored: 0,
      reason: "start_blocked",
    };
  }

  const open = new MinHeap();
  open.push({ key: startKey, x: start.x, y: start.y, g: 0, priority: manhattan(start, target) });

  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  let explored = 0;
  let bestKey = startKey;
  let bestDistance = manhattan(start, target);

  const maxExpansions = Math.max(1000, Math.min(200000, grid.length * grid[0].length * 10));

  while (open.size > 0 && explored < maxExpansions) {
    const current = open.pop();
    if (!current) break;
    const currentKey = current.key;
    if (current.g !== gScore.get(currentKey)) {
      continue;
    }

    explored += 1;
    const currentPos = { x: current.x, y: current.y };
    const dist = manhattan(currentPos, target);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestKey = currentKey;
    }

    if (currentKey === targetKey) {
      const keys = reconstructPath(cameFrom, startKey, targetKey);
      return {
        keys,
        reachedTarget: true,
        finalPosition: { ...target },
        explored,
        reason: "reached",
      };
    }

    for (const dir of DIRECTIONS) {
      const next = attemptMove({
        grid,
        from: currentPos,
        dir,
        movementMode: mode,
        allowTransitions,
        target,
      });
      if (!next) continue;
      const nextKey = `${next.x},${next.y}`;
      const tentativeG = current.g + 1;
      const known = gScore.get(nextKey);
      if (known != null && tentativeG >= known) continue;
      gScore.set(nextKey, tentativeG);
      cameFrom.set(nextKey, { prevKey: currentKey, moveKey: dir.key });
      const priority = tentativeG + manhattan(next, target);
      open.push({ key: nextKey, x: next.x, y: next.y, g: tentativeG, priority });
    }
  }

  const finalPosition = bestKey === startKey ? { ...start } : parseKey(bestKey);
  const fallbackKeys = reconstructPath(cameFrom, startKey, bestKey);
  return {
    keys: fallbackKeys,
    reachedTarget: false,
    finalPosition,
    explored,
    reason: "unreachable",
  };
}

module.exports = { findLocalPath };
