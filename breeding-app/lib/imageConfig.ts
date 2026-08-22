// Shared OpenAI image-generation constants for this app - same values as
// the parent repo's lib/onlychansConfig.ts, kept as a local copy since this
// is a separate Vercel project (see next.config.ts) with no import access
// back into the parent repo.
export const IMAGE_MODEL = "gpt-image-1";
export const IMAGE_SIZE = "1024x1024";
// "low" keeps cost down across 12 dummy Girlfriend mints plus every future
// breeding event - this is a placeholder/illustrative-art pipeline, not a
// flagship-quality one.
export const IMAGE_QUALITY = "low";
