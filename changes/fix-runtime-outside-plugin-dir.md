---
type: fixed
---
VS Code no longer hangs each turn on `EMFILE`: `node bin/setup.js` installs mermaid-cli and puppeteer into a per-user data directory instead of the plugin, `fetch-icons.sh` puts the icon mirror there too, and setup moves out or deletes what older versions left inside the plugin.
