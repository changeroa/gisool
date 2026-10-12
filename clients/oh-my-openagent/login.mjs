#!/usr/bin/env node
import { login } from "../oauth-login.mjs";

try { await login("oh-my-openagent"); }
catch (error) { console.error(error.message); process.exitCode = 1; }
