// @ts-nocheck
// Claude entry: the named handle() the claude-code-loader proxy imports for the antigravity provider.

import { runProviderMenu, buildAccountMenu } from "../core-auth/dist/index.js";
import { driver } from "./driver/index.js";

export const handle = driver.handle;
export const accounts = driver.accounts;
export const menu = () => runProviderMenu(driver);   // standalone (full-screen select) — Claude loader / oc auth login
export const menuModel = () => buildAccountMenu(driver);   // the menu MODEL — opencode loader renders it natively in-tab
