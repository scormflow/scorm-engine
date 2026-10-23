import type { InsightContext } from './context.js';

/** What a tenant can ask the AI layer for. */
export const INSIGHT_KINDS = ['insights', 'summary', 'recommendations'] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export function isInsightKind(value: unknown): value is InsightKind {
  return typeof value === 'string' && (INSIGHT_KINDS as readonly string[]).includes(value);
}

const SYSTEM = [
  'You are a learning-analytics assistant inside ScormFlow, an e-learning runtime.',
  'You are given aggregate data about learners’ attempts at SCORM courses as JSON.',
  'Ground every statement in that data and quote the numbers behind it; rates are fractions from 0 to 1, present them as percentages.',
  'If the sample is too small to support a conclusion (fewer than about 10 attempts), say so instead of guessing.',
  'When a "journey" is present it lists course locations in order with the share of attempts that reached each one; "steepestDrops" are the biggest falls in reach between consecutive locations — use them to say where learners leave (e.g. "reach falls 43% after slide 8").',
  'Never invent learners, courses, objectives or questions that are not in the data.',
  'Placeholders such as [EMAIL] or [PHONE] mark redacted personal data; do not try to reconstruct it.',
  'Answer in concise Markdown.',
].join(' ');

const TASKS: Record<InsightKind, string> = {
  insights:
    'List the 3 to 5 most important findings, most important first: where learners drop off (and how long they spent there), which objectives and questions they fail, and anything unusual about completion, pass rate, score or time. One short bullet each, with the figure that supports it.',
  summary:
    'Write a short summary (at most 150 words) of how learners are doing, then name the concepts they struggle with most, as judged by failed objectives and missed questions.',
  recommendations:
    'Recommend 3 to 5 concrete actions for the course owner — content to revise, remediation to offer learners who fail a given objective, questions to reword — each tied to the evidence that motivates it.',
};

export function buildPrompt(kind: InsightKind, context: InsightContext, question?: string): { system: string; prompt: string } {
  const lines = [
    TASKS[kind],
    ...(question ? ['', `The course owner also asks: ${question}`] : []),
    '',
    'Data:',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
  ];
  return { system: SYSTEM, prompt: lines.join('\n') };
}
