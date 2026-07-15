import type { MemorySearchHit } from "./search.js";

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
    if (left.updatedAt && right.updatedAt && left.updatedAt !== right.updatedAt) {
      return right.updatedAt.localeCompare(left.updatedAt);
    }
  }

  return left.path.localeCompare(right.path);
}
