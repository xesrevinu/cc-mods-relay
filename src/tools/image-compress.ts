/** JPEG quality the model still reads well; 85 is the usual "visually enough" point. */
export const IMAGE_JPEG_QUALITY = 85;
/** Anthropic downscales the long edge past this, so extra pixels only cost context. */
export const IMAGE_MAX_EDGE = 1568;
export const IMAGE_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_PIXELS = 8192 * 8192;

export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type CompressedImage = {
  bytes: Buffer;
  mime: ImageMime;
  originalSize: number;
  dimensions: {
    originalWidth: number;
    originalHeight: number;
    displayWidth: number;
    displayHeight: number;
  };
};

function displaySize(width: number, height: number): { displayWidth: number; displayHeight: number } {
  const long = Math.max(width, height);
  if (long <= IMAGE_MAX_EDGE) return { displayWidth: width, displayHeight: height };
  const scale = IMAGE_MAX_EDGE / long;
  return { displayWidth: Math.max(1, Math.round(width * scale)), displayHeight: Math.max(1, Math.round(height * scale)) };
}

export async function compressImage(source: Buffer, mime: ImageMime): Promise<CompressedImage> {
  const originalSize = source.byteLength;
  const fallback = (width: number, height: number): CompressedImage => ({
    bytes: source,
    mime,
    originalSize,
    dimensions: { originalWidth: width, originalHeight: height, displayWidth: width, displayHeight: height },
  });

  let width = 0;
  let height = 0;
  try {
    const meta = await new Bun.Image(source, { maxPixels: MAX_PIXELS }).metadata();
    width = meta.width;
    height = meta.height;
  } catch {
    if (originalSize > IMAGE_MAX_OUTPUT_BYTES) {
      throw new Error(`Image is ${originalSize} bytes and could not be decoded; the API limit is ${IMAGE_MAX_OUTPUT_BYTES} bytes`);
    }
    return fallback(0, 0);
  }

  try {
    let encoded: Buffer | undefined;
    let displayWidth = 0;
    let displayHeight = 0;
    for (const quality of [IMAGE_JPEG_QUALITY, 70, 55]) {
      const pipeline = new Bun.Image(source, { maxPixels: MAX_PIXELS, autoOrient: true })
        .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality });
      encoded = Buffer.from(await pipeline.bytes());
      const shown = displaySize(width, height);
      displayWidth = pipeline.width > 0 ? pipeline.width : shown.displayWidth;
      displayHeight = pipeline.height > 0 ? pipeline.height : shown.displayHeight;
      if (encoded.byteLength <= IMAGE_MAX_OUTPUT_BYTES) break;
    }
    if (!encoded) throw new Error("image encode produced no bytes");
    const neededResize = displayWidth !== width || displayHeight !== height;
    const keepOriginal = encoded.byteLength >= originalSize && !neededResize && originalSize <= IMAGE_MAX_OUTPUT_BYTES;
    if (keepOriginal) return fallback(width, height);
    if (encoded.byteLength > IMAGE_MAX_OUTPUT_BYTES) {
      throw new Error(`Compressed image is ${encoded.byteLength} bytes; the API limit is ${IMAGE_MAX_OUTPUT_BYTES} bytes`);
    }
    return {
      bytes: encoded,
      mime: "image/jpeg",
      originalSize,
      dimensions: { originalWidth: width, originalHeight: height, displayWidth, displayHeight },
    };
  } catch (error) {
    if (originalSize <= IMAGE_MAX_OUTPUT_BYTES) return fallback(width, height);
    throw error instanceof Error ? error : new Error(String(error));
  }
}
