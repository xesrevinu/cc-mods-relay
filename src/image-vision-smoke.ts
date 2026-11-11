export const VISION_CONFIRMED_CLAUDE_VERSION = "2.1.195";

export interface VisionSmokeResult {
  confirmed: boolean;
  detail: string;
}

export function versionGte(a: string, b: string): boolean {
  const partsA = a.split(".");
  const partsB = b.split(".");
  for (let i = 0; i < 3; i++) {
    const na = toComponent(partsA[i]);
    const nb = toComponent(partsB[i]);
    if (na !== nb) {
      return na > nb;
    }
  }
  return true;
}

function toComponent(part: string | undefined): number {
  if (part === undefined) {
    return 0;
  }
  const n = Number.parseInt(part, 10);
  return Number.isNaN(n) ? 0 : n;
}

const SEMVER_RE = /^(\d+\.\d+\.\d+)/;

export function imageVisionSmoke(version: string | null | undefined): VisionSmokeResult {
  const parsed = typeof version === "string" ? SEMVER_RE.exec(version) : null;
  if (parsed && versionGte(parsed[1], VISION_CONFIRMED_CLAUDE_VERSION)) {
    return {
      confirmed: true,
      detail: `claude ${parsed[1]} >= ${VISION_CONFIRMED_CLAUDE_VERSION} — @image is confirmed to vision-encode via Read`,
    };
  }
  const named = parsed ? parsed[1] : "undetected";
  return {
    confirmed: false,
    detail:
      `@image vision-encoding is UNCONFIRMED on this claude (detected ${named}; confirmed at ` +
      `${VISION_CONFIRMED_CLAUDE_VERSION}+). Sending images anyway — image input is NOT blocked — but ` +
      `if the picture is ignored, upgrade claude to ${VISION_CONFIRMED_CLAUDE_VERSION} or newer`,
  };
}

export function reportImageVisionSmoke(
  version: string | null | undefined,
  log: (...args: unknown[]) => void = console.error,
): VisionSmokeResult {
  const result = imageVisionSmoke(version);
  if (!result.confirmed) {
    log(`[image-vision] ${result.detail}`);
  }
  return result;
}
