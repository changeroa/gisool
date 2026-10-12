#!/usr/bin/env node
import { login } from "../oauth-login.mjs";

try { await login("gajae-code"); }
catch (error) { console.error(error.message); process.exitCode = 1; }
