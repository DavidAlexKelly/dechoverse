/**
 * Turns whatever a Platform SDK call threw into something short enough for the
 * HUD. PalantirApiError carries `errorName` (for example
 * PublishRecordToStreamPermissionDenied), which is the useful part.
 */
export function describeError(error: unknown): string {
  if (error != null && typeof error === "object") {
    const candidate = error as {
      errorName?: unknown;
      errorCode?: unknown;
      message?: unknown;
    };
    if (typeof candidate.errorName === "string") {
      return candidate.errorName;
    }
    if (typeof candidate.errorCode === "string") {
      return candidate.errorCode;
    }
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
  }
  return String(error);
}
