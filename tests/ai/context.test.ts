import { describe, expect, it } from 'vitest';

import { buildJourney } from '../../src/ai/context.js';
import type { LocationHeat } from '../../src/replay/heatmap.js';

const heat = (location: string, attempts: number, extra: Partial<LocationHeat> = {}): LocationHeat => ({
  location,
  visits: attempts,
  attempts,
  totalActiveSeconds: attempts * 30,
  avgActiveSeconds: 30,
  interactions: 0,
  dropOffs: 0,
  pointer: [],
  ...extra,
});

describe('buildJourney', () => {
  it('is null when no attempt visited a location', () => {
    expect(buildJourney({ attempts: 0, completed: 0, grid: 10, locations: [] })).toBeNull();
    expect(buildJourney({ attempts: 3, completed: 0, grid: 10, locations: [] })).toBeNull();
  });

  it('turns reach into rates and ranks the steepest falls between consecutive locations', () => {
    const journey = buildJourney({
      attempts: 10,
      completed: 3,
      grid: 10,
      locations: [
        heat('intro', 10),
        heat('s1', 9, { dropOffs: 1 }),
        heat('s2', 4, { dropOffs: 4, avgActiveSeconds: 210 }),
        heat('s3', 4),
        heat('quiz', 3, { interactions: 12 }),
      ],
    })!;
    expect(journey.locations.map((l) => l.reachRate)).toEqual([1, 0.9, 0.4, 0.4, 0.3]);
    expect(journey.locations[2]).toEqual({
      location: 's2',
      reached: 4,
      reachRate: 0.4,
      dropOffs: 4,
      dropOffRate: 1,
      avgActiveSeconds: 210,
      interactions: 0,
    });
    // Flat steps (s2 → s3) are not drops.
    expect(journey.steepestDrops.map((d) => [d.after, d.next, d.drop])).toEqual([
      ['s1', 's2', 0.5],
      ['intro', 's1', 0.1],
      ['s3', 'quiz', 0.1],
    ]);
  });

  it('caps long courses and says so', () => {
    const locations = Array.from({ length: 55 }, (_, i) => heat(`p${i}`, 5));
    const journey = buildJourney({ attempts: 5, completed: 5, grid: 10, locations })!;
    expect(journey.locations).toHaveLength(40);
    expect(journey.truncated).toBe(true);
    expect(journey.steepestDrops).toEqual([]);
  });
});
