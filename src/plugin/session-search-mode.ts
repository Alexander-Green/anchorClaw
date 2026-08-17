import type { OpenClawPluginApi } from "../api.js";

export const NATIVE_SESSION_SEARCH_MIN_OPENCLAW_VERSION = "2026.8.1-beta.1";

export type SessionSearchMode = "legacy-anchorclaw" | "native-openclaw";

type ParsedVersion = {
  core: [number, number, number];
  prerelease: Array<string | number>;
};

function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/u, "").split("+")[0] ?? "";
  const prereleaseSeparator = normalized.indexOf("-");
  const rawCore = prereleaseSeparator === -1 ? normalized : normalized.slice(0, prereleaseSeparator);
  const rawPrerelease =
    prereleaseSeparator === -1 ? "" : normalized.slice(prereleaseSeparator + 1);
  const coreParts = rawCore?.split(".") ?? [];
  if (
    coreParts.length !== 3 ||
    coreParts.some((part) => !/^(?:0|[1-9]\d*)$/u.test(part)) ||
    (prereleaseSeparator !== -1 && !rawPrerelease)
  ) {
    return null;
  }
  const core = coreParts.map((part) => Number(part)) as [number, number, number];
  const rawPrereleaseParts = rawPrerelease ? rawPrerelease.split(".") : [];
  if (
    rawPrereleaseParts.some(
      (part) =>
        !part ||
        !/^[0-9A-Za-z-]+$/u.test(part) ||
        (/^\d+$/u.test(part) && !/^(?:0|[1-9]\d*)$/u.test(part)),
    )
  ) {
    return null;
  }
  const prerelease = rawPrereleaseParts.map((part) =>
    /^\d+$/u.test(part) ? Number(part) : part,
  );
  return { core, prerelease };
}

function compareIdentifiers(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "number") {
    return -1;
  }
  if (typeof right === "number") {
    return 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareOpenClawVersions(left: string, right: string): number | null {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const difference = parsedLeft.core[index]! - parsedRight.core[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    return parsedLeft.prerelease.length === parsedRight.prerelease.length
      ? 0
      : parsedLeft.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    const difference = compareIdentifiers(leftPart, rightPart);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function resolveSessionSearchMode(api: OpenClawPluginApi): SessionSearchMode {
  const runtimeVersion = (api as any)?.runtime?.version;
  if (typeof runtimeVersion !== "string") {
    return "legacy-anchorclaw";
  }
  const comparison = compareOpenClawVersions(
    runtimeVersion,
    NATIVE_SESSION_SEARCH_MIN_OPENCLAW_VERSION,
  );
  return comparison !== null && comparison >= 0 ? "native-openclaw" : "legacy-anchorclaw";
}
