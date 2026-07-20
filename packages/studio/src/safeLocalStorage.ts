/**
 * Safe wrappers around localStorage that handle:
 * - Private / incognito browsing mode (SecurityError)
 * - Storage quota exceeded (QuotaExceededError on setItem)
 * - Any other browser-specific storage restriction
 *
 * All functions absorb exceptions so callers never need try/catch.
 * getItem returns null on failure (same contract as the native API on a miss).
 * setItem returns false to signal storage failure instead of throwing.
 */

export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // No-op — if storage is inaccessible there is nothing to remove.
  }
}
