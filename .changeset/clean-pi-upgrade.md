---
"@jmfederico/pi-web": patch
---

Upgrade bundled Pi packages to version 1.2.0, keep their internal system-prompt messages out of PI WEB's browser history and live events, and check model authentication before starting companion requests. Pi still stores its system prompt in session files for resume. Docker development builds use npm's configured registry unless PI_WEB_NPM_REGISTRY is set.
