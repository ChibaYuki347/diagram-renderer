#!/usr/bin/env bash
# fetch-icons.sh — license-safe icon acquisition for diagram-renderer
#
# Populates <skill>/.local-assets/ (i.e. the directory next to this script's
# parent — wherever the skill happens to be installed) with icon SVGs that the
# renderer can use to inline external <image href="..."> references in drawio
# SVG exports (when "Embed Images" is OFF). The renderer auto-discovers this
# same path, so no configuration is needed.
#
# Behavior:
#   * GitHub Octicons: auto-downloaded via `npm install --no-save @primer/octicons` (MIT).
#   * Microsoft Azure / M365 / Power Platform / Entra: print the official
#     download URL + license summary, wait for the user to drop the ZIP into
#     `.local-assets/_inbox/`, then extract.
#
# Usage:
#   ./scripts/fetch-icons.sh              # interactive (asks per set)
#   ./scripts/fetch-icons.sh github       # only fetch a specific set
#   ./scripts/fetch-icons.sh azure m365 power-platform entra github
#
# Environment:
#   READ_AND_AGREE=1   # bypass interactive license prompt (you've read the
#                      # terms in assets/icons/LICENSE.md and agree to follow
#                      # them for your use case).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS_DIR="$SKILL_DIR/.local-assets"
INBOX_DIR="$ASSETS_DIR/_inbox"
LICENSE_DOC="$SKILL_DIR/assets/icons/LICENSE.md"

# ──────────────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────────────

c_bold=$'\033[1m'
c_dim=$'\033[2m'
c_yellow=$'\033[33m'
c_cyan=$'\033[36m'
c_green=$'\033[32m'
c_red=$'\033[31m'
c_reset=$'\033[0m'

# All log helpers write to stderr so that functions that capture stdout
# (e.g. `zip=$(wait_for_zip ...)`) don't accidentally swallow log lines
# into the return value.
log()  { printf "%s%s%s\n" "$c_cyan"  "$*" "$c_reset" >&2; }
warn() { printf "%s%s%s\n" "$c_yellow" "$*" "$c_reset" >&2; }
ok()   { printf "%s%s%s\n" "$c_green" "$*" "$c_reset" >&2; }
err()  { printf "%s%s%s\n" "$c_red"   "$*" "$c_reset" >&2; }

confirm_terms() {
  local set_name="$1"
  local url="$2"
  local terms="$3"
  cat >&2 <<EOF

${c_bold}${set_name}${c_reset}
  Source: ${url}
  Terms (summary, verify on the official page):
${terms}

  Full posture: see ${LICENSE_DOC}
EOF
  if [[ "${READ_AND_AGREE:-0}" == "1" ]]; then
    ok "  READ_AND_AGREE=1 — skipping interactive prompt."
    return 0
  fi
  printf "%s" "  Type 'I agree' to proceed (or Ctrl-C to abort): " >&2
  read -r response
  if [[ "$response" != "I agree" ]]; then
    warn "  Skipping $set_name (consent not given)."
    return 1
  fi
}

wait_for_zip() {
  local set_name="$1"
  local zip_glob="$2"
  mkdir -p "$INBOX_DIR"
  # If READ_AND_AGREE=1 AND a matching ZIP is already in the inbox, skip the
  # interactive Enter prompt — this enables non-interactive runs (CI / agent).
  local pre_found
  pre_found=$(find "$INBOX_DIR" -maxdepth 1 -type f -iname "$zip_glob" 2>/dev/null | head -1)
  if [[ "${READ_AND_AGREE:-0}" == "1" && -n "$pre_found" ]]; then
    ok "  ✓ Found ZIP in inbox (non-interactive): $pre_found"
    printf "%s" "$pre_found"
    return 0
  fi
  log ""
  log "  Drop the downloaded ZIP into:"
  log "    $INBOX_DIR/"
  log ""
  log "  Expected filename pattern: $zip_glob"
  log "  (Press Enter once the ZIP is in place, or Ctrl-C to abort.)"
  read -r _
  local found
  found=$(find "$INBOX_DIR" -maxdepth 1 -type f -iname "$zip_glob" 2>/dev/null | head -1)
  if [[ -z "$found" ]]; then
    err "  No file matching '$zip_glob' found in $INBOX_DIR/"
    err "  Files currently in inbox:"
    ls -la "$INBOX_DIR/" >&2 || true
    return 1
  fi
  printf "%s" "$found"
}

# ──────────────────────────────────────────────────────────────────────────
# Octicons (auto, MIT)
# ──────────────────────────────────────────────────────────────────────────

fetch_github() {
  log ""
  log "${c_bold}=== GitHub Octicons (MIT, auto-fetch) ===${c_reset}"
  local dest="$ASSETS_DIR/github/octicons"
  mkdir -p "$dest"
  local stage
  stage=$(mktemp -d)
  trap "rm -rf '$stage'" RETURN

  ( cd "$stage" && npm install --no-save --silent --prefix "$stage" @primer/octicons >/dev/null )

  local src="$stage/node_modules/@primer/octicons/build/svg"
  if [[ ! -d "$src" ]]; then
    err "  npm install completed but $src not found."
    return 1
  fi

  cp -r "$src/." "$dest/"
  cp "$stage/node_modules/@primer/octicons/LICENSE" "$ASSETS_DIR/github/LICENSE" 2>/dev/null || true

  local count
  count=$(find "$dest" -type f -name '*.svg' | wc -l)
  ok "  ✓ Installed $count Octicon SVGs into $dest"
}

# ──────────────────────────────────────────────────────────────────────────
# Microsoft Azure architecture icons (manual)
# ──────────────────────────────────────────────────────────────────────────

fetch_azure() {
  log ""
  log "${c_bold}=== Azure architecture icons (manual, Microsoft proprietary) ===${c_reset}"
  confirm_terms "Azure architecture icons" \
    "https://learn.microsoft.com/en-us/azure/architecture/icons/" \
"    • Use in architectural diagrams describing Microsoft products/services: OK
    • Modification, advertising, sales collateral, redistribution: NOT permitted
    • Diagrams may be commercial as long as they describe MS products/services" \
    || return 0

  local zip
  zip=$(wait_for_zip "Azure" "Azure_Public_Service_Icons*.zip")
  [[ -z "$zip" ]] && return 1

  local dest="$ASSETS_DIR/azure"
  mkdir -p "$dest"
  local stage
  stage=$(mktemp -d)
  unzip -q "$zip" -d "$stage"

  # Locate the "Icons" tree. Different Azure pack versions have used
  #   * Azure_Public_Service_Icons/Icons/<category>/...   (V20+)
  #   * Azure_Public_Service_Icons/SVG_Icons/<category>/... (older)
  #   * SVG/<category>/... (very old)
  local icons_root
  icons_root=$(find "$stage" -maxdepth 4 -type d \( -iname Icons -o -iname SVG_Icons -o -iname SVGIcons \) 2>/dev/null | head -1)
  if [[ -z "$icons_root" ]]; then
    err "  Could not find Icons/ root inside $zip"
    err "  Top-level entries:"
    find "$stage" -maxdepth 2 -mindepth 1 >&2
    rm -rf "$stage"
    return 1
  fi

  # Normalize and copy each SVG into a drawio-conformant layout under $dest:
  #   * category:  "ai + machine learning" → "ai_machine_learning"
  #                "management + governance" → "management_governance"
  #   * filename:  "00028-icon-service-Batch-AI.svg" → "Batch_AI.svg"
  #   * BOTH a normalized copy AND the original filename are written, so:
  #     - drawio /img/lib/azure2/<cat>/<Name>.svg refs resolve via the resolver
  #     - users that hand-write refs to the original MS filename also resolve
  local copied=0
  while IFS= read -r f; do
    local cat_raw norm_cat fname norm_fname rel_dir
    cat_raw=$(basename "$(dirname "$f")")
    # category normalize: lower, ' + ' → '_', any remaining ' ' → '_'
    norm_cat=$(printf "%s" "$cat_raw" \
      | tr '[:upper:]' '[:lower:]' \
      | sed -E 's/ *\+ */_/g; s/ +/_/g')
    fname=$(basename "$f")
    # filename normalize: strip leading digits + "-icon-service-", then '-' → '_'
    norm_fname=$(printf "%s" "$fname" \
      | sed -E 's/^[0-9]+-icon-service-//' \
      | tr '-' '_')
    rel_dir="$dest/$norm_cat"
    mkdir -p "$rel_dir"
    cp "$f" "$rel_dir/$norm_fname"
    # Also preserve the original filename (idempotent) for provenance / debugging
    cp "$f" "$rel_dir/$fname"
    copied=$((copied + 1))
  done < <(find "$icons_root" -type f -name '*.svg')

  # Preserve the Microsoft Terms of Use PDF alongside the icons for audit
  local terms_pdf
  terms_pdf=$(find "$stage" -maxdepth 3 -type f -iname 'Microsoft_Terms_of_Use*.pdf' 2>/dev/null | head -1)
  if [[ -n "$terms_pdf" ]]; then
    cp "$terms_pdf" "$dest/Microsoft_Terms_of_Use.pdf"
  fi
  local faq_pdf
  faq_pdf=$(find "$stage" -maxdepth 3 -type f -iname 'Azure_Icons_FAQ*.pdf' 2>/dev/null | head -1)
  if [[ -n "$faq_pdf" ]]; then
    cp "$faq_pdf" "$dest/Azure_Icons_FAQ.pdf"
  fi

  rm -rf "$stage"
  ok "  ✓ Azure icons extracted: $copied SVGs into $dest (drawio-conformant + original names)"
  log "    Categories present: $(find "$dest" -mindepth 1 -maxdepth 1 -type d -printf '%f ' | tr ' ' '\n' | sort | tr '\n' ' ')"
}

# ──────────────────────────────────────────────────────────────────────────
# Microsoft 365 / Office 365 icons (manual)
# ──────────────────────────────────────────────────────────────────────────

fetch_m365() {
  log ""
  log "${c_bold}=== Microsoft 365 icons ===${c_reset}"
  warn "  As of late 2025, Microsoft no longer publishes a standalone Microsoft 365"
  warn "  architecture icons ZIP. The previous M365 stencils page redirects users"
  warn "  to the Azure architecture icons pack (which already includes M365 service"
  warn "  icons under the appropriate categories — e.g., intune/, security/, etc.)."
  warn ""
  warn "  Action:"
  warn "    1. Run \`fetch-icons.sh azure\` (if not already done) — it covers most"
  warn "       M365 architecture stencils used in real diagrams."
  warn "    2. For Office product-family icons (Word/Excel/PowerPoint UI iconography),"
  warn "       use Microsoft Fluent UI icons (separate licensing posture) — not in scope."
  warn ""
  warn "  Skipping: no separate M365 pack to extract."
  return 0
}

# ──────────────────────────────────────────────────────────────────────────
# Microsoft Power Platform icons (manual)
# ──────────────────────────────────────────────────────────────────────────

fetch_power_platform() {
  log ""
  log "${c_bold}=== Power Platform icons (manual, Microsoft proprietary) ===${c_reset}"
  confirm_terms "Power Platform icons" \
    "https://learn.microsoft.com/en-us/power-platform/guidance/icons" \
"    • Use in architectural diagrams describing Microsoft products/services: OK
    • Modification, advertising, sales collateral, redistribution: NOT permitted
    • Power Apps, Power Automate, Power BI, Power Pages, Copilot Studio, Dataverse" \
    || return 0

  local zip
  zip=$(wait_for_zip "Power Platform" "Power-Platform-icons*.zip")
  [[ -z "$zip" ]] && return 1

  local dest="$ASSETS_DIR/power-platform"
  mkdir -p "$dest"
  local stage
  stage=$(mktemp -d)
  unzip -q "$zip" -d "$stage"

  # The PP pack mixes root-level SVGs (Agent365, CopilotStudio) with a
  # "Power Platform/" subfolder (AIBuilder, PowerApps, ...). Flatten both
  # into $dest while normalizing names:
  #   - strip "_scalable" suffix → matches drawio shape names more naturally
  #   - replace spaces with underscores
  local copied=0
  while IFS= read -r f; do
    local fname norm
    fname=$(basename "$f")
    norm=$(printf "%s" "$fname" | sed -E 's/_scalable\.svg$/.svg/' | tr ' ' '_')
    cp "$f" "$dest/$norm"
    # Preserve original too
    cp "$f" "$dest/$fname"
    copied=$((copied + 1))
  done < <(find "$stage" -type f -name '*.svg')

  # Preserve the CELA licenses PDF if present
  find "$stage" -maxdepth 4 -type f -iname '*Licenses*.pdf' -exec cp {} "$dest/" \;
  find "$stage" -maxdepth 4 -type f -iname '*FAQ*.pdf' -exec cp {} "$dest/" \;

  rm -rf "$stage"
  ok "  ✓ Power Platform icons extracted: $copied SVGs into $dest"
  log "    Names available: $(find "$dest" -maxdepth 1 -name '*.svg' -not -iname '*_scalable*' -printf '%f ' 2>/dev/null | tr ' ' '\n' | head -10 | tr '\n' ' ')"
}

# ──────────────────────────────────────────────────────────────────────────
# Entra ID icons (manual)
# ──────────────────────────────────────────────────────────────────────────

fetch_entra() {
  log ""
  log "${c_bold}=== Entra ID icons (manual, Microsoft proprietary) ===${c_reset}"
  confirm_terms "Entra ID icons" \
    "https://learn.microsoft.com/en-us/entra/architecture/architecture-icons" \
"    • Use in architectural diagrams describing Microsoft products/services: OK
    • Modification, advertising, sales collateral, redistribution: NOT permitted
    • Microsoft Entra ID family (ID / Governance / Internet Access / Private Access /
      Verified ID / Workload ID) — BW + color flavors" \
    || return 0

  local zip
  zip=$(wait_for_zip "Entra" "Microsoft*Entra*icons*.zip")
  [[ -z "$zip" ]] && return 1

  local dest="$ASSETS_DIR/entra"
  mkdir -p "$dest/bw" "$dest/color"
  local stage
  stage=$(mktemp -d)
  unzip -q "$zip" -d "$stage"

  # The Entra pack ships:
  #   <Pack>/Microsoft Entra BW icons SVG/Microsoft Entra <Product> BW icon.svg
  #   <Pack>/Microsoft Entra color icons SVG/Microsoft Entra <Product> color icon.svg
  # Normalize to $dest/{bw,color}/<Product>.svg + preserve originals.
  local copied=0
  while IFS= read -r f; do
    local dir_name fname norm flavor
    dir_name=$(basename "$(dirname "$f")")
    fname=$(basename "$f")
    if [[ "$dir_name" == *"BW icons"* ]]; then
      flavor="bw"
    elif [[ "$dir_name" == *"color icons"* ]]; then
      flavor="color"
    else
      # Default flavor if structure changes in future versions
      flavor="other"
      mkdir -p "$dest/other"
    fi
    # normalize: strip "Microsoft Entra " prefix and " BW icon"/" color icon" suffix
    norm=$(printf "%s" "$fname" \
      | sed -E 's/^Microsoft Entra //' \
      | sed -E 's/( BW icon| color icon| filled BW icon| Product Family| \(product family\))//g' \
      | tr ' ' '_')
    cp "$f" "$dest/$flavor/$norm"
    # Preserve original name too (in flavor folder for cleanliness)
    cp "$f" "$dest/$flavor/$fname"
    copied=$((copied + 1))
  done < <(find "$stage" -type f -name '*.svg')

  # Preserve Branding Playbook for reference
  find "$stage" -type f -iname '*Playbook*.pptx' -exec cp {} "$dest/" \;

  rm -rf "$stage"
  ok "  ✓ Entra icons extracted: $copied SVGs into $dest (bw/ + color/ + originals)"
  log "    BW available: $(find "$dest/bw" -maxdepth 1 -name '*.svg' -not -name 'Microsoft*' -printf '%f ' 2>/dev/null)"
  log "    Color available: $(find "$dest/color" -maxdepth 1 -name '*.svg' -not -name 'Microsoft*' -printf '%f ' 2>/dev/null)"
}

# ──────────────────────────────────────────────────────────────────────────
# Entrypoint
# ──────────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $(basename "$0") [SET...]

Sets:
  github            GitHub Octicons (auto, MIT)
  azure             Microsoft Azure architecture icons (manual)
  m365              Microsoft 365 icons (manual)
  power-platform    Microsoft Power Platform icons (manual)
  entra             Microsoft Entra ID icons (manual)
  all               All of the above (default if no args given)

Environment:
  READ_AND_AGREE=1   skip per-set "I agree" prompts (you've read LICENSE.md
                     and agree to the relevant terms for your use case)

See $LICENSE_DOC for full licensing posture.
EOF
}

main() {
  local args=("$@")
  if [[ ${#args[@]} -eq 0 ]]; then
    args=(all)
  fi

  for arg in "${args[@]}"; do
    case "$arg" in
      github)         fetch_github ;;
      azure)          fetch_azure ;;
      m365)           fetch_m365 ;;
      power-platform) fetch_power_platform ;;
      entra)          fetch_entra ;;
      all)
        fetch_github
        fetch_azure
        fetch_m365
        fetch_power_platform
        fetch_entra
        ;;
      -h|--help|help) usage ; exit 0 ;;
      *) err "Unknown set: $arg" ; usage ; exit 2 ;;
    esac
  done

  log ""
  ok "Done. Local cache: $ASSETS_DIR"
  log ""
  log "Next steps:"
  log "  1. (optional) Inspect $ASSETS_DIR and verify filenames match the URLs in your drawio SVGs."
  log "  2. (optional) Add manual overrides to assets/icons/aliases.json for any mismatches."
  log "  3. Render: node bin/render-drawio.js <your.drawio.svg> --asset-root '$ASSETS_DIR'"
  log "     (asset-root is auto-discovered if you don't pass it.)"
}

main "$@"
