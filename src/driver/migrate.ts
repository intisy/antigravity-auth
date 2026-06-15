// @ts-nocheck
// One-time import of legacy antigravity-accounts.json into the core-auth store; anything that isn't a first-class CoreAccount field goes into `meta` so nothing is lost.

import { join } from "path";
import { migrateLegacy } from "../../core-auth/dist/index.js";
import { parseRefreshParts } from "../plugin/auth.js";

const LEGACY_FILE = "antigravity-accounts.json";

export function mapLegacyAccount(entry) {
  if (!entry || !entry.refreshToken) return null;
  const parts = parseRefreshParts(entry.refreshToken);
  if (!parts.refreshToken) return null;
  return {
    id: entry.email || parts.refreshToken.slice(0, 16),
    email: entry.email,
    refresh: parts.refreshToken,
    addedAt: entry.addedAt || Date.now(),
    lastUsed: entry.lastUsed || 0,
    enabled: entry.enabled !== false,
    rateLimitResetTimes: entry.rateLimitResetTimes || {},
    coolingDownUntil: entry.coolingDownUntil || 0,
    cooldownReason: entry.cooldownReason || null,
    meta: {
      projectId: parts.projectId || entry.projectId,
      managedProjectId: parts.managedProjectId || entry.managedProjectId,
      proxies: entry.proxies,
      lastSwitchReason: entry.lastSwitchReason,
      fingerprint: entry.fingerprint,
      fingerprintHistory: entry.fingerprintHistory,
      verificationRequired: entry.verificationRequired,
      verificationRequiredAt: entry.verificationRequiredAt,
      verificationRequiredReason: entry.verificationRequiredReason,
      verificationUrl: entry.verificationUrl,
      cachedQuota: entry.cachedQuota,
      cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
    },
  };
}

// run once on init; no-op if the core store for this provider is already populated
export function runMigration(providerId, configDir) {
  const legacyPath = join(configDir, "config", LEGACY_FILE);
  return migrateLegacy(providerId, legacyPath, mapLegacyAccount);
}
