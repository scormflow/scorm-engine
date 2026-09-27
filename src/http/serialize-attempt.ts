/**
 * Shared JSON serializer for Attempt rows, matching the `Attempt` schema in
 * openapi.yaml. Used by both the attempts routes and analytics `recentAttempts`.
 */
export function serializeAttempt(a: any): Record<string, unknown> {
  return {
    id: a.id,
    status: a.status,
    courseId: a.courseId,
    lessonStatus: a.lessonStatus,
    completionStatus: a.completionStatus,
    successStatus: a.successStatus,
    lessonLocation: a.lessonLocation,
    score: { raw: a.scoreRaw, min: a.scoreMin, max: a.scoreMax, scaled: a.scoreScaled },
    progressMeasure: a.progressMeasure,
    sessionTimeSeconds: a.sessionTimeSeconds,
    totalTimeSeconds: a.totalTimeSeconds,
    objectives: (a.objectives ?? []).map((o: any) => ({
      identifier: o.identifier,
      successStatus: o.successStatus,
      completionStatus: o.completionStatus,
      score: { raw: o.scoreRaw, scaled: o.scoreScaled },
      progressMeasure: o.progressMeasure,
    })),
    interactions: (a.interactions ?? []).map((i: any) => ({
      identifier: i.identifier,
      type: i.type,
      learnerResponse: i.learnerResponse,
      result: i.result,
    })),
    startedAt: a.startedAt instanceof Date ? a.startedAt.toISOString() : a.startedAt ?? null,
    finishedAt: a.finishedAt instanceof Date ? a.finishedAt.toISOString() : a.finishedAt ?? null,
  };
}
