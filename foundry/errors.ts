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

/**
 * Everything the platform said, not just the status line — for places with
 * room to show it, like the agents console.
 *
 * The OSDK's default message is "Failed to fetch 400 Bad Request", which is
 * the one piece of information that does not help. Foundry returns an
 * errorName, an errorInstanceId and named parameters in the body, and those
 * name the real problem.
 */
export function describeApiError(error: unknown): string {
  const candidate = (error ?? {}) as {
    message?: unknown;
    errorName?: unknown;
    errorCode?: unknown;
    errorInstanceId?: unknown;
    parameters?: unknown;
  };
  const parts: string[] = [];
  if (typeof candidate.errorCode === "string") {
    parts.push(candidate.errorCode);
  }
  if (typeof candidate.errorName === "string") {
    parts.push(candidate.errorName);
  }
  if (typeof candidate.message === "string") {
    parts.push(candidate.message);
  }
  if (candidate.parameters != null) {
    try {
      parts.push(JSON.stringify(candidate.parameters));
    } catch {
      // A parameter bag that will not serialise is not worth failing over.
    }
  }
  if (typeof candidate.errorInstanceId === "string") {
    parts.push(`instance ${candidate.errorInstanceId}`);
  }
  return parts.length > 0 ? parts.join(" · ") : String(error);
}
