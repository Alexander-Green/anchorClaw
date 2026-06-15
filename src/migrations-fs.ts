import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function loadBundledMigrationsFromDir(relativeDir: string): Promise<
  Array<{ filename: string; sql: string }>
> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.resolve(here, "..", relativeDir);
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((entry: { isFile(): boolean; name: string }) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry: { name: string }) => entry.name)
    .sort((a: string, b: string) => a.localeCompare(b));

  const migrations: Array<{ filename: string; sql: string }> = [];
  for (const filename of files) {
    const sql = await fs.readFile(path.join(migrationsDir, filename), "utf8");
    migrations.push({ filename, sql });
  }
  return migrations;
}

export async function loadBundledMigrationsFromDisk(): Promise<
  Array<{ filename: string; sql: string }>
> {
  return loadBundledMigrationsFromDir("migrations");
}

export async function loadBundledSemanticMigrationsFromDisk(): Promise<
  Array<{ filename: string; sql: string }>
> {
  return loadBundledMigrationsFromDir(path.join("migrations", "semantic"));
}
