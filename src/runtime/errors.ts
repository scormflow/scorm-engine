/**
 * SCORM Run-Time Environment (RTE) API error codes.
 *
 * SCORM 1.2 and SCORM 2004 share a numeric error-code space but assign
 * different meanings to some codes. Each data-model implementation reports
 * codes from its own edition; the values here are the union, tagged by the
 * edition that defines them. `ScormApiError.code` is always the raw number the
 * browser-side API adapter is expected to surface via `GetLastError()`.
 */
export const Scorm12ErrorCode = {
  NoError: 0,
  GeneralException: 101,
  InvalidArgument: 201,
  ElementCannotHaveChildren: 202,
  ElementNotAnArray: 203,
  NotInitialized: 301,
  NotImplemented: 401,
  ElementIsKeyword: 402,
  ElementReadOnly: 403,
  ElementWriteOnly: 404,
  IncorrectDataType: 405,
} as const;

export const Scorm2004ErrorCode = {
  NoError: 0,
  GeneralException: 101,
  GeneralInitializationFailure: 102,
  AlreadyInitialized: 103,
  ContentInstanceTerminated: 104,
  GeneralTerminationFailure: 111,
  TerminationBeforeInitialization: 112,
  TerminationAfterTermination: 113,
  RetrieveDataBeforeInitialization: 122,
  RetrieveDataAfterTermination: 123,
  StoreDataBeforeInitialization: 132,
  StoreDataAfterTermination: 133,
  CommitBeforeInitialization: 142,
  CommitAfterTermination: 143,
  GeneralArgumentError: 201,
  GeneralGetFailure: 301,
  GeneralSetFailure: 351,
  GeneralCommitFailure: 391,
  UndefinedDataModelElement: 401,
  UnimplementedDataModelElement: 402,
  ValueNotInitialized: 403,
  ElementReadOnly: 404,
  ElementWriteOnly: 405,
  TypeMismatch: 406,
  ValueOutOfRange: 407,
  DependencyNotEstablished: 408,
} as const;

export type ScormErrorCode = number;

/**
 * Thrown by data-model reads/writes and by the session lifecycle. Carries the
 * numeric RTE code so the transport layer can echo it back to the content.
 */
export class ScormApiError extends Error {
  constructor(
    public readonly code: ScormErrorCode,
    message: string,
    /** The data-model element that triggered the error, when applicable. */
    public readonly element?: string,
  ) {
    super(message);
    this.name = 'ScormApiError';
  }
}
