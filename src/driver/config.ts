// @ts-nocheck
// Antigravity driver configuration; secrets are env-first with public-installed-app constants as fallback so the repo stays secret-free.

import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
} from "../constants.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export function clientId() { return process.env.ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_CLIENT_ID; }
export function clientSecret() { return process.env.ANTIGRAVITY_CLIENT_SECRET || ANTIGRAVITY_CLIENT_SECRET; }

// getters, not values: creds are fetched into process.env on first use, which can
// happen after this object is built, so refresh must read them lazily
export function oauthConfig() {
  return {
    tokenUrl: TOKEN_URL,
    get clientId() { return clientId(); },
    get clientSecret() { return clientSecret(); },
  };
}

export const endpoints = {
  token: TOKEN_URL,
  authorize: AUTHORIZE_URL,
  redirectUri: ANTIGRAVITY_REDIRECT_URI,
  scopes: ANTIGRAVITY_SCOPES,
  request: ANTIGRAVITY_ENDPOINT_FALLBACKS,   // daily -> autopush -> prod
  project: ANTIGRAVITY_LOAD_ENDPOINTS,       // prod -> daily -> autopush
  primary: ANTIGRAVITY_ENDPOINT,
  geminiCli: GEMINI_CLI_ENDPOINT,
};
