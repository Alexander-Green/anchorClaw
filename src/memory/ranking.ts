import type { MemorySearchHit } from "./search.js";

function normalizeUpdatedAt(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return typeof value === "string" ? value : undefined;
}

export function compareMemorySearchHits(left: MemorySearchHit, right: MemorySearchHit): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  const leftIsDurable = left.corpus === "memory";
  const rightIsDurable = right.corpus === "memory";
  if (leftIsDurable !== rightIsDurable) {
    return leftIsDurable ? -1 : 1;
  }

  if (leftIsDurable && rightIsDurable) {
    const importanceDifference = (right.importance ?? 0) - (left.importance ?? 0);
    if (importanceDifference !== 0) {
      return importanceDifference;
    }
    const leftUpdatedAt = normalizeUpdatedAt(left.updatedAt);
    const rightUpdatedAt = normalizeUpdatedAt(right.updatedAt);
    if (leftUpdatedAt && rightUpdatedAt && leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt.localeCompare(leftUpdatedAt);
    }
  }

  return left.path.localeCompare(right.path);
}
