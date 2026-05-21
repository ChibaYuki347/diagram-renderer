# Icon library licensing

This Skill bundles **no icon assets** in the repository itself. Icons live in
the user's local cache (`~/.copilot/skills/diagram-renderer/.local-assets/`,
gitignored) and must be downloaded by the user under the appropriate license
terms via `scripts/fetch-icons.sh`.

This file summarizes the licensing posture per icon set so users can confirm
their use case is permitted before downloading.

## TL;DR

| Icon set | License | Auto-fetchable? | Use in slides? |
|---|---|---|---|
| GitHub Octicons | **MIT** (Primer/GitHub) | ✅ `npm install --no-save @primer/octicons` | ✅ Any |
| Azure architecture icons | Microsoft proprietary, free for use **in architectural diagrams describing Microsoft products/services** | ⚠️ Manual download | ✅ Microsoft-related diagrams |
| Microsoft 365 icons | Microsoft proprietary, similar to Azure terms | ⚠️ Manual download | ✅ Microsoft-related diagrams |
| Power Platform icons | Microsoft proprietary, similar to Azure terms | ⚠️ Manual download | ✅ Microsoft-related diagrams |
| Entra ID / Identity icons | Subset of Azure architecture icons + Microsoft brand guidelines | ⚠️ Manual download | ✅ Microsoft-related diagrams |

> "Manual download" = the user must visit the official Microsoft page, accept
> the terms displayed there, and download a ZIP. The `fetch-icons.sh` script
> prints the URL + terms summary and waits for the user to drop the ZIP into
> `.local-assets/_inbox/` before extracting.

## Sources & terms (verify yourself)

### GitHub Octicons — MIT
- **Source**: https://github.com/primer/octicons (`@primer/octicons` on npm)
- **License**: MIT — see [LICENSE](https://github.com/primer/octicons/blob/main/LICENSE)
- **Permitted**: any use, including commercial
- **Required**: include the MIT copyright notice if you redistribute the icons

### Microsoft Azure architecture icons
- **Source**: https://learn.microsoft.com/en-us/azure/architecture/icons/
- **Terms summary** (verify on the official page):
  - "You may use the icons in architectural diagrams ... that describe a product, service, or feature offered by Microsoft, or convey concepts about cloud computing."
  - "You may not modify the icons. You may not use Microsoft icons in advertising, promotional materials, sales collateral, or other commercial works."
  - Distribution restrictions apply — these icons **cannot be redistributed** as part of a public skill repository.
- **This skill's posture**: never commit Azure icons to the repo. Keep them in
  the user's local `.local-assets/azure/`. The committable artifact is
  `resolver-rules.json` only.

### Microsoft 365 / Office 365 icons
- **Source**: https://www.microsoft.com/en-us/microsoft-365/microsoft-365-icons (or via the same architecture icons download for service icons)
- **Terms**: similar Microsoft proprietary terms — diagram use OK, commercial redistribution not.

### Microsoft Power Platform icons
- **Source**: https://learn.microsoft.com/en-us/power-platform/admin/admin-documentation (or the same Azure architecture icons pack — Power Platform icons are often packaged together)
- **Terms**: see Microsoft Trademark and Brand Guidelines.

### Microsoft Entra ID icons
- **Source**: Part of the Azure architecture icons pack (`identity/` category) plus Entra-specific brand guidelines at https://learn.microsoft.com/en-us/entra/
- **Terms**: same as Azure architecture icons.

## Why this Skill does NOT auto-fetch the Microsoft sets

The Microsoft icon packs each have a download page that displays terms and
sometimes requires acceptance. Programmatically bypassing that flow would:
1. risk breaking when Microsoft updates the page/URL,
2. potentially violate the spirit of the terms (which expect user acknowledgement).

So `fetch-icons.sh` prints the URLs and waits for the user to drop the ZIP in
the `_inbox/` folder. This makes the user's role in agreeing to terms explicit.

GitHub Octicons under MIT can be auto-fetched (and re-distributed) freely.

## Adding new icon sets

If you want to add a non-Microsoft non-Octicon icon set (e.g. AWS, third-party
SaaS, OSS), follow the same pattern:
1. Add the source's terms to this file
2. Add a resolver rule to `resolver-rules.json`
3. Either extend `fetch-icons.sh` (if license permits) or document manual DL
4. Verify your use case is permitted by the source's terms
