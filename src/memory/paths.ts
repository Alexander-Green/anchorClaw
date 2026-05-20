export type DbMemoryPath =
  | { kind: "item"; id: string }
  | { kind: "daily"; id: string }
  | { kind: "export"; name: "MEMORY.md" };

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

export function parseDbMemoryPath(pathValue: string): DbMemoryPath | null {
  const trimmed = pathValue.trim();
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "db-memory") {
    return null;
  }

  if (parts[1] === "items" && parts.length === 3) {
    const filename = parts[2]!;
    if (!filename.endsWith(".md")) {
      return null;
    }
    const id = filename.slice(0, -3);
    return isUuidLike(id) ? { kind: "item", id } : null;
  }

  if (parts[1] === "daily" && parts.length === 3) {
    const filename = parts[2]!;
    if (!filename.endsWith(".md")) {
      return null;
    }
    const id = filename.slice(0, -3);
    return isUuidLike(id) ? { kind: "daily", id } : null;
  }

  if (parts[1] === "export" && parts.length === 3 && parts[2] === "MEMORY.md") {
    return { kind: "export", name: "MEMORY.md" };
  }

  return null;
}
