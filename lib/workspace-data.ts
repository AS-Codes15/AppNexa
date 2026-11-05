import type { FileData, Message } from "@/types/workspace";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string" &&
    (value.imageUrl === undefined || typeof value.imageUrl === "string")
  );
}

export function parseMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isMessage);
}

export function parseFileData(raw: unknown): FileData | null {
  if (!isRecord(raw) || !isRecord(raw.files) || !isRecord(raw.dependencies)) {
    return null;
  }

  const files: FileData["files"] = {};
  for (const [path, file] of Object.entries(raw.files)) {
    if (!isRecord(file) || typeof file.code !== "string") return null;
    files[path] = { code: file.code };
  }

  const dependencies: FileData["dependencies"] = {};
  for (const [name, version] of Object.entries(raw.dependencies)) {
    if (typeof version !== "string") return null;
    dependencies[name] = version;
  }

  return {
    files,
    dependencies,
    title: typeof raw.title === "string" ? raw.title : undefined,
  };
}
