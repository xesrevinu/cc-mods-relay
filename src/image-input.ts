import { writeFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

export const MATERIALIZED_IMAGE_PREFIX = "fork-acp-img-";

export function extFor(mimeType: string | undefined | null): string {
  const media = (mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  switch (media) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".img";
  }
}

export function materializeImage(data: string, mimeType: string | undefined | null): string {
  const bytes = Buffer.from(data, "base64");
  const tempPath = path.join(
    os.tmpdir(),
    MATERIALIZED_IMAGE_PREFIX + randomUUID() + extFor(mimeType),
  );
  writeFileSync(tempPath, bytes);
  return tempPath;
}

export function cleanupMaterializedImages(paths: readonly string[] | undefined): void {
  if (!paths) return;
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
    }
  }
}
