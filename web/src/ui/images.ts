/** Getting pictures ready for an Image field: checks the format and shrinks big photos. */
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "../../../shared/model";

/** Longest side kept for photos; plenty for a screen, and keeps databases small. */
const MAX_SIDE = 2400;

export class ImageError extends Error {}

export async function prepareImage(file: Blob): Promise<Blob> {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new ImageError("That file isn't a picture Access Web can store. Use a PNG, JPEG, GIF or WebP image.");
  }
  // GIFs may be animated; keep them as they are.
  if (file.type === "image/gif") {
    if (file.size > MAX_IMAGE_BYTES) throw new ImageError("That GIF is larger than 5 MB.");
    return file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (file.size > MAX_IMAGE_BYTES) throw new ImageError("That picture is larger than 5 MB.");
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // PNGs may be transparent, so they become WebP (which keeps it); photos stay JPEG.
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
  for (const quality of [0.86, 0.75, 0.6]) {
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    if (out && out.size <= MAX_IMAGE_BYTES) return out;
  }
  throw new ImageError("That picture is too large to store, even made smaller.");
}

/** The first picture among dropped or pasted files, if any. */
export function pictureIn(list: FileList | DataTransferItemList | null | undefined): File | null {
  if (!list) return null;
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = item instanceof File ? item : item.kind === "file" ? item.getAsFile() : null;
    if (file && file.type.startsWith("image/")) return file;
  }
  return null;
}
