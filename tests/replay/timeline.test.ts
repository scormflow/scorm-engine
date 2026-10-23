import { describe, expect, it } from 'vitest';

import {
  buildCourseHeatmap,
  buildTimeline,
  parseReplayEvents,
  ReplayError,
  type ReplayAttemptInput,
} from '../../src/replay/index.js';

const T0 = new Date('2026-10-16T09:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function attempt(overrides: Partial<ReplayAttemptInput> = {}): ReplayAttemptInput {
  return {
    version: 'SCORM_2004_4',
    startedAt: T0,
    finishedAt: null,
    lastCommitAt: null,
    status: 'IN_PROGRESS',
    completionStatus: 'INCOMPLETE',
    successStatus: 'UNKNOWN',
    lessonStatus: 'INCOMPLETE',
    progressMeasure: null,
    ...overrides,
  };
}

describe('buildTimeline', () => {
  it('keeps the finish after the terminating commit logged a few ms later', () => {
    const finishedAt = at(300);
    const timeline = buildTimeline(
      attempt({ finishedAt, completionStatus: 'COMPLETED', status: 'COMPLETED' }),
      [
        { at: at(10), values: { 'cmi.location': 'slide-1', 'cmi.completion_status': 'incomplete' } },
        { at: new Date(finishedAt.getTime() + 3), values: { 'cmi.location': 'slide-1', 'cmi.completion_status': 'completed' } },
      ],
      [],
    );
    const types = timeline.entries.map((e) => e.type);
    expect(types[types.length - 1]).toBe('attempt.finished');
    // The terminating commit's entries come right before it.
    expect(timeline.entries.at(-2)!.at).toBe(new Date(finishedAt.getTime() + 3).toISOString());
  });

  it('diffs consecutive commits into what the content reported', () => {
    const timeline = buildTimeline(
      attempt({ finishedAt: at(300), completionStatus: 'COMPLETED', successStatus: 'PASSED', status: 'COMPLETED' }),
      [
        { at: at(10), values: { 'cmi.location': 'slide-1', 'cmi.completion_status': 'incomplete' } },
        {
          at: at(100),
          values: {
            'cmi.location': 'slide-2',
            'cmi.completion_status': 'incomplete',
            'cmi.interactions.0.id': 'q1',
            'cmi.interactions.0.type': 'choice',
            'cmi.interactions.0.result': 'incorrect',
            'cmi.interactions.0.learner_response': 'b',
          },
        },
        {
          at: at(300),
          values: {
            'cmi.location': 'slide-2',
            'cmi.completion_status': 'completed',
            'cmi.success_status': 'passed',
            'cmi.score.scaled': '0.9',
            'cmi.score.raw': '90',
            'cmi.interactions.0.id': 'q1',
            'cmi.interactions.0.type': 'choice',
            'cmi.interactions.0.result': 'incorrect',
            'cmi.interactions.0.learner_response': 'b',
          },
        },
      ],
      [],
    );

    expect(timeline.entries.map((e) => e.type)).toEqual([
      'attempt.started',
      'location.changed',
      'status.changed',
      'location.changed',
      'interaction.recorded',
      'status.changed',
      'status.changed',
      'score.changed',
      'attempt.finished',
    ]);
    const answered = timeline.entries.find((e) => e.type === 'interaction.recorded')!;
    expect(answered).toMatchObject({
      source: 'content',
      location: 'slide-2',
      offsetSeconds: 100,
      data: { id: 'q1', result: 'incorrect', learnerResponse: 'b' },
    });
    // A location change belongs to the slide being left.
    expect(timeline.entries[3]).toMatchObject({ location: 'slide-1', data: { from: 'slide-1', to: 'slide-2' } });
    expect(timeline.entries.find((e) => e.type === 'score.changed')!.data).toMatchObject({ raw: 90, scaled: 0.9 });

    expect(timeline.visits).toEqual([
      { location: 'slide-1', enteredAt: at(10).toISOString(), leftAt: at(100).toISOString(), activeSeconds: 90 },
      { location: 'slide-2', enteredAt: at(100).toISOString(), leftAt: at(300).toISOString(), activeSeconds: 200 },
    ]);
    expect(timeline.durationSeconds).toBe(300);
    expect(timeline.commits).toBe(3);
    expect(timeline.captured).toBe(false);
  });

  it('reads SCORM 1.2 element names', () => {
    const timeline = buildTimeline(
      attempt({ version: 'SCORM_1_2', lessonStatus: 'PASSED', completionStatus: 'COMPLETED' }),
      [
        { at: at(5), values: { 'cmi.core.lesson_location': 'p1', 'cmi.core.lesson_status': 'incomplete' } },
        {
          at: at(60),
          values: { 'cmi.core.lesson_location': 'p2', 'cmi.core.lesson_status': 'passed', 'cmi.core.score.raw': '80' },
        },
      ],
      [],
    );
    expect(timeline.visits.map((v) => v.location)).toEqual(['p1', 'p2']);
    const statuses = timeline.entries.filter((e) => e.type === 'status.changed').map((e) => e.data['to']);
    expect(statuses).toEqual(['incomplete', 'passed']);
    expect(timeline.entries.find((e) => e.type === 'score.changed')!.data).toMatchObject({ raw: 80, scaled: null });
    expect(timeline.engagement.components.progress).toBe(1);
  });

  it('does not count a suspended stretch as time on the slide', () => {
    const timeline = buildTimeline(
      attempt(),
      [
        { at: at(0), values: { 'cmi.location': 's1' } },
        { at: at(60), values: { 'cmi.location': 's1', 'cmi.exit': 'suspend' } },
        // Two days later the learner resumes.
        { at: at(172_860), values: { 'cmi.location': 's1' } },
        { at: at(172_920), values: { 'cmi.location': 's2' } },
      ],
      [],
    );
    const types = timeline.entries.map((e) => e.type);
    expect(types).toContain('session.suspended');
    expect(types).toContain('session.resumed');
    expect(timeline.visits[0]).toMatchObject({ location: 's1', activeSeconds: 120 });
    expect(timeline.engagement.activeSeconds).toBe(120);
  });

  it('merges client capture events and scores focus from them', () => {
    const timeline = buildTimeline(
      attempt({ progressMeasure: 0.5 }),
      [{ at: at(0), values: { 'cmi.location': 'intro' } }],
      [
        { at: at(10), type: 'navigation', location: 'video', data: {} },
        { at: at(20), type: 'media.play', location: null, data: { src: 'intro.mp4' } },
        { at: at(40), type: 'page.hidden', location: null, data: {} },
        { at: at(100), type: 'page.visible', location: null, data: {} },
        { at: at(110), type: 'pointer', location: null, data: { x: 0.5, y: 0.5 } },
        { at: at(120), type: 'quiz.skipped', location: 'quiz', data: {} },
      ],
    );
    expect(timeline.captured).toBe(true);
    // Client events with no location inherit the one the learner navigated to.
    expect(timeline.entries.find((e) => e.type === 'media.play')).toMatchObject({ source: 'client', location: 'video' });
    expect(timeline.visits.map((v) => v.location)).toEqual(['intro', 'video']);
    expect(timeline.visits[1]).toMatchObject({ activeSeconds: 50 });

    const { engagement } = timeline;
    expect(engagement.hiddenSeconds).toBe(60);
    expect(engagement.focusLosses).toBe(1);
    expect(engagement.activeSeconds).toBe(60);
    expect(engagement.components.progress).toBe(0.5);
    expect(engagement.components.focus).toBe(0.5);
    expect(engagement.components.interactivity).toBe(0.2);
    // 100 * (0.5*0.4 + 0.5*0.3 + 0.2*0.3) / 1.0
    expect(engagement.score).toBe(41);
    expect(engagement.level).toBe('medium');
  });

  it('reweights when there is no capture and no interaction', () => {
    const timeline = buildTimeline(
      attempt({ completionStatus: 'COMPLETED', finishedAt: at(60) }),
      [{ at: at(30), values: { 'cmi.completion_status': 'completed' } }],
      [],
    );
    expect(timeline.engagement.components).toEqual({ progress: 1, focus: null, interactivity: null });
    expect(timeline.engagement.score).toBe(100);
    expect(timeline.engagement.level).toBe('high');
  });

  it('treats a long silence as time away', () => {
    const timeline = buildTimeline(
      attempt(),
      [
        { at: at(0), values: { 'cmi.location': 'a' } },
        { at: at(3 * 3600), values: { 'cmi.location': 'b' } },
      ],
      [],
    );
    expect(timeline.visits[0]).toMatchObject({ location: 'a', activeSeconds: 0 });
  });
});

describe('buildCourseHeatmap', () => {
  it('aggregates visits, interactions, drop-offs and pointer cells per location in course order', () => {
    const run = (locations: string[], completed: boolean, pointer?: { x: number; y: number }) => ({
      completed,
      timeline: buildTimeline(
        attempt(),
        locations.map((l, i) => ({
          at: at(i * 60),
          values:
            l === 'quiz'
              ? { 'cmi.location': l, 'cmi.interactions.0.id': 'q1', 'cmi.interactions.0.result': 'correct' }
              : { 'cmi.location': l },
        })),
        pointer ? [{ at: at(1), type: 'pointer', location: null, data: pointer }] : [],
      ),
    });

    const heatmap = buildCourseHeatmap([
      run(['intro', 'body', 'quiz', 'end'], true, { x: 0.95, y: 0.05 }),
      run(['intro', 'body'], false, { x: 0.96, y: 0.01 }),
      run(['intro', 'body', 'quiz'], false),
    ]);

    expect(heatmap).toMatchObject({ attempts: 3, completed: 1, grid: 10 });
    expect(heatmap.locations.map((l) => l.location)).toEqual(['intro', 'body', 'quiz', 'end']);
    const byName = Object.fromEntries(heatmap.locations.map((l) => [l.location, l]));
    expect(byName['intro']).toMatchObject({ visits: 3, attempts: 3, avgActiveSeconds: 60, pointer: [{ x: 9, y: 0, count: 2 }] });
    expect(byName['body']).toMatchObject({ dropOffs: 1 });
    expect(byName['quiz']).toMatchObject({ attempts: 2, interactions: 2, dropOffs: 1 });
    expect(byName['end']).toMatchObject({ attempts: 1, dropOffs: 0 });
  });
});

describe('parseReplayEvents', () => {
  const now = at(600);
  const parse = (events: unknown) => parseReplayEvents(events, T0, now);

  it('accepts known and content-defined event types', () => {
    const parsed = parse([
      { id: 'e1', type: 'page.hidden', at: at(10).toISOString() },
      { type: 'quiz.skipped', at: at(20).toISOString(), location: 'q3', data: { reason: 'timeout' } },
      { type: 'pointer', at: at(30).toISOString(), data: { x: 0, y: 1 } },
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ clientId: 'e1', type: 'page.hidden', location: null });
    expect(parsed[1]).toMatchObject({ clientId: null, location: 'q3', data: { reason: 'timeout' } });
  });

  it.each([
    [[], /non-empty/],
    [[{ type: 'Page Hidden', at: at(1).toISOString() }], /type must be/],
    [[{ type: 'page.hidden', at: 'yesterday' }], /ISO 8601/],
    [[{ type: 'page.hidden', at: at(-3600).toISOString() }], /outside the attempt/],
    [[{ type: 'page.hidden', at: at(3600).toISOString() }], /outside the attempt/],
    [[{ type: 'pointer', at: at(1).toISOString(), data: { x: 2, y: 0 } }], /pointer events/],
    [[{ type: 'x', at: at(1).toISOString(), data: { blob: 'x'.repeat(3000) } }], /2048 bytes/],
    [[{ type: 'x', at: at(1).toISOString(), id: 'has space' }], /id must be/],
  ])('rejects %j', (events, message) => {
    expect(() => parse(events)).toThrow(ReplayError);
    expect(() => parse(events)).toThrow(message);
  });
});
