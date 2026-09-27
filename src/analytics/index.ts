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
