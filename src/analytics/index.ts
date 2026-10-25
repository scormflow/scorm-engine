/**
 * Analytics read models over the Attempt table (tenant / course / learner
 * rollups). Pure aggregation — no writes.
 */
export {
  getCourseAnalytics,
  getLearnerAnalytics,
  getOverview,
} from './service.js';
export type {
  AnalyticsOverview,
  CourseAnalytics,
  LearnerAnalytics,
} from './service.js';
export {
  DEFAULT_SCORE_BINS,
  DEFAULT_TREND_DAYS,
  MAX_SCORE_BINS,
  MAX_TREND_DAYS,
  MIN_SCORE_BINS,
  getScoreDistribution,
  getTrends,
} from './trends.js';
export type {
  AnalyticsTrends,
  ScoreBin,
  ScoreDistribution,
  TrendBucket,
  TrendOptions,
} from './trends.js';
