import { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin } from "./plugin";

export { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin };

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./antigravity/oauth";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./antigravity/oauth";

export default AntigravityCLIOAuthPlugin;

export const server = AntigravityCLIOAuthPlugin;

