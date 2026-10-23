/**
 * Course heatmap: fold many attempts' replay timelines into per-location
 * figures — how many learners reached each slide / page, how long they stayed,
 * how much they interacted there, where unfinished attempts stopped, and (with
 * client capture) where on the page they pointed.
 */
import type { AttemptTimeline } from './timeline.js';

/** Pointer positions are bucketed into a POINTER_GRID × POINTER_GRID grid. */
export const POINTER_GRID = 10;

export interface HeatmapCell {
  x: number;
  y: number;
  count: number;
}

export interface LocationHeat {
  location: string;
  /** Visits across all attempts (a learner going back counts again). */
  visits: number;
  /** Attempts that reached the location at least once. */
  attempts: number;
  totalActiveSeconds: number;
  avgActiveSeconds: number;
  interactions: number;
  /** Unfinished attempts whose last location was this one. */
  dropOffs: number;
  /** Non-empty pointer grid cells (x, y in 0..POINTER_GRID-1). */
  pointer: HeatmapCell[];
}

export interface CourseHeatmap {
  attempts: number;
  /** Attempts that reached completion (or a pass / fail outcome). */
  completed: number;
  grid: number;
  /** In course order: by the average position at which attempts first reached them. */
  locations: LocationHeat[];
}

export interface HeatmapAttempt {
  timeline: AttemptTimeline;
  /** Whether the attempt finished the course (completed, passed or failed). */
  completed: boolean;
}

export function buildCourseHeatmap(attempts: readonly HeatmapAttempt[]): CourseHeatmap {
  const byLocation = new Map<
    string,
    LocationHeat & { attemptSet: Set<number>; ordinals: number[]; cells: Map<string, number> }
  >();
  const heat = (location: string) => {
    let row = byLocation.get(location);
    if (!row) {
      row = {
        location,
        visits: 0,
        attempts: 0,
        totalActiveSeconds: 0,
        avgActiveSeconds: 0,
        interactions: 0,
        dropOffs: 0,
        pointer: [],
        attemptSet: new Set(),
        ordinals: [],
        cells: new Map(),
      };
      byLocation.set(location, row);
    }
    return row;
  };

  attempts.forEach(({ timeline, completed }, n) => {
    const firstSeen: string[] = [];
    for (const visit of timeline.visits) {
      const row = heat(visit.location);
      row.visits += 1;
      row.totalActiveSeconds += visit.activeSeconds;
      if (!row.attemptSet.has(n)) {
        row.attemptSet.add(n);
        firstSeen.push(visit.location);
      }
    }
    // Normalized so a 5-slide attempt and a 50-slide one weigh the same.
    firstSeen.forEach((location, i) => heat(location).ordinals.push(firstSeen.length > 1 ? i / (firstSeen.length - 1) : 0));

    for (const entry of timeline.entries) {
      if (entry.location === null) continue;
      if (entry.type === 'interaction.recorded') heat(entry.location).interactions += 1;
      if (entry.type === 'pointer') {
        const x = cell(entry.data['x']);
        const y = cell(entry.data['y']);
        if (x === null || y === null) continue;
        const cells = heat(entry.location).cells;
        cells.set(`${x},${y}`, (cells.get(`${x},${y}`) ?? 0) + 1);
      }
    }

    const last = timeline.visits[timeline.visits.length - 1];
    if (!completed && last) heat(last.location).dropOffs += 1;
  });

  const avg = (ns: number[]) => (ns.length === 0 ? 1 : ns.reduce((s, v) => s + v, 0) / ns.length);
  const locations = [...byLocation.values()]
    .sort((a, b) => avg(a.ordinals) - avg(b.ordinals) || a.location.localeCompare(b.location))
    .map(({ attemptSet, ordinals: _ordinals, cells, ...row }): LocationHeat => ({
      ...row,
      attempts: attemptSet.size,
      totalActiveSeconds: Math.round(row.totalActiveSeconds * 10) / 10,
      avgActiveSeconds: row.visits > 0 ? Math.round((row.totalActiveSeconds / row.visits) * 10) / 10 : 0,
      pointer: [...cells.entries()]
        .map(([key, count]) => {
          const [x, y] = key.split(',').map(Number) as [number, number];
          return { x, y, count };
        })
        .sort((a, b) => a.y - b.y || a.x - b.x),
    }));

  return {
    attempts: attempts.length,
    completed: attempts.filter((a) => a.completed).length,
    grid: POINTER_GRID,
    locations,
  };
}

/** Bucket a 0–1 coordinate into a grid column / row; null when it is not one. */
function cell(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
  return Math.min(POINTER_GRID - 1, Math.floor(v * POINTER_GRID));
}
