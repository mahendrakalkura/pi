import type { InlineExtension } from "../core/extensions/types.ts";

/**
 * Extensions compiled into the Bun binary.
 *
 * This module is empty in the source tree. `scripts/build-pi-binary.ts` replaces it at bundle time
 * with static imports of every extension found under PI_BUNDLE_DIR, so the release binary loads
 * them as inline extensions without touching the filesystem or a package store at startup.
 */
export const bundledExtensions: InlineExtension[] = [];
