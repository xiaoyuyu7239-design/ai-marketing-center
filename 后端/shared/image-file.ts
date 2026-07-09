export const MAX_PRODUCT_IMAGES = 5;

const IMAGE_FILE_EXTENSION_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

export function isSupportedImageFile(file: File) {
  return file.type.toLowerCase().startsWith("image/") || IMAGE_FILE_EXTENSION_RE.test(file.name);
}
