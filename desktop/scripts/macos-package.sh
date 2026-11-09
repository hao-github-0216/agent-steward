#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: macos-package.sh --app <app> --out <dmg> [--identity <name>]
                        [--notarize] [--allow-single-arch]

Validate an already-built App and create a drag-to-Applications DMG.
Without --identity the App must be ad-hoc signed; the DMG is left unsigned.
With --identity the App and sidecars must already have Developer ID signatures,
hardened runtime, and secure timestamps. Only the DMG is signed here.
--notarize additionally requires an already notarized/stapled App and the
APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_PATH environment variables.
Universal x86_64 + arm64 binaries are required unless --allow-single-arch is set.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

app=''
out=''
identity=''
notarize=false
allow_single_arch=false
while (($#)); do
  case "$1" in
    --app|--out|--identity)
      option=$1
      (($# >= 2)) || fail "Missing value for $option"
      [[ -n "$2" && "$2" != --* ]] || fail "Missing value for $option"
      case "$option" in
        --app) [[ -z "$app" ]] || fail 'Duplicate --app'; app=$2 ;;
        --out) [[ -z "$out" ]] || fail 'Duplicate --out'; out=$2 ;;
        --identity) [[ -z "$identity" ]] || fail 'Duplicate --identity'; identity=$2 ;;
      esac
      shift 2
      ;;
    --notarize) notarize=true; shift ;;
    --allow-single-arch) allow_single_arch=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$app" ]] || fail '--app is required'
[[ -n "$out" ]] || fail '--out is required'
app=${app%/}
[[ "$app" == *.app && -d "$app/Contents/MacOS" ]] || fail '--app must be an existing .app bundle'
[[ -d "$app/Contents/Resources" ]] || fail 'App Contents/Resources is missing'
[[ "$out" == *.dmg ]] || fail '--out must end in .dmg'
[[ -d "$(dirname "$out")" ]] || fail '--out parent directory must exist'
app=$(cd "$app" && pwd -P)
out="$(cd "$(dirname "$out")" && pwd -P)/$(basename "$out")"
case "$out" in "$app"/*) fail '--out must not be inside the source App' ;; esac
[[ ! -L "$out" && ! -d "$out" ]] || fail '--out must not be a symlink or directory'

if "$notarize"; then
  [[ -n "$identity" ]] || fail '--notarize requires --identity'
  [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]] ||
    fail '--notarize requires APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_PATH'
  [[ -f "$APPLE_API_KEY_PATH" && -r "$APPLE_API_KEY_PATH" ]] || fail 'APPLE_API_KEY_PATH must name a readable file'
fi

for tool in lipo codesign file find mktemp ditto ln hdiutil; do
  command -v "$tool" >/dev/null || fail "Required tool not found: $tool"
done
[[ -x /usr/libexec/PlistBuddy ]] || fail 'Required tool not found: /usr/libexec/PlistBuddy'
if "$notarize"; then
  for tool in xcrun plutil spctl; do
    command -v "$tool" >/dev/null || fail "Required tool not found: $tool"
  done
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-steward-package.XXXXXX")
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for binary in agent-steward-desktop node herdr ttyd; do
  path="$app/Contents/MacOS/$binary"
  [[ -f "$path" && -x "$path" ]] || fail "Missing executable: Contents/MacOS/$binary"
  architectures=$(lipo -archs "$path") || fail "Cannot read architectures: $binary"
  if [[ " $architectures " == *' x86_64 '* && " $architectures " == *' arm64 '* ]]; then
    :
  elif "$allow_single_arch" && [[ " $architectures " == *' x86_64 '* || " $architectures " == *' arm64 '* ]]; then
    printf 'Allowing single architecture for %s: %s\n' "$binary" "$architectures"
  else
    fail "$binary must contain x86_64 and arm64 (found: $architectures); use --allow-single-arch for local builds"
  fi
done

codesign --verify --deep --strict --verbose=2 "$app" || fail 'App signature verification failed'
codesign -d --entitlements - --xml "$app/Contents/MacOS/node" 2>/dev/null >"$work_dir/node-entitlements.plist" ||
  fail 'Cannot read Node entitlements'
for entitlement in com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory; do
  value=$(/usr/libexec/PlistBuddy -c "Print :$entitlement" "$work_dir/node-entitlements.plist" 2>/dev/null) ||
    fail "Node is missing entitlement: $entitlement"
  [[ "$value" == true ]] || fail "Node entitlement must be true: $entitlement"
done

# Follow resource symlinks as well: executable code belongs in Contents/MacOS.
find -L "$app/Contents/Resources" -type f -print0 >"$work_dir/resources.list"
found_macho=false
while IFS= read -r -d '' resource; do
  description=$(file -L -b "$resource") || fail "Cannot inspect resource: $resource"
  if [[ "$description" == *Mach-O* ]]; then
    printf 'Mach-O found under Resources: %s (%s)\n' "$resource" "$description" >&2
    found_macho=true
  fi
done <"$work_dir/resources.list"
"$found_macho" && fail 'Resources must not contain Mach-O files'

if [[ -n "$identity" ]]; then
  for target in "$app" "$app/Contents/MacOS/node" "$app/Contents/MacOS/herdr" "$app/Contents/MacOS/ttyd"; do
    signature=$(codesign -dv --verbose=4 "$target" 2>&1) || fail "Cannot inspect signature: $target"
    grep -Eq '^Authority=Developer ID Application:' <<<"$signature" || fail "Developer ID Application signature required: $target"
    grep -Eq 'flags=[^[:space:]]*[(,]runtime[),]' <<<"$signature" || fail "Hardened runtime required: $target"
    grep -Eq '^Timestamp=.+' <<<"$signature" || fail "Secure timestamp required: $target"
    if grep -Eiq '^Timestamp=(none|not set)$' <<<"$signature"; then
      fail "Secure timestamp required: $target"
    fi
  done
else
  signature=$(codesign -dv --verbose=4 "$app" 2>&1) || fail 'Cannot inspect App signature'
  grep -Eq '^Signature=adhoc$' <<<"$signature" || fail 'Without --identity, the App must have Signature=adhoc'
fi

if "$notarize"; then
  xcrun stapler validate "$app" ||
    fail 'Tauri must notarize and staple the App before this script packages it (Tauri 必須先公證及 staple App).'
fi

mkdir "$work_dir/payload"
ditto "$app" "$work_dir/payload/$(basename "$app")"
ln -s /Applications "$work_dir/payload/Applications"
hdiutil create -volname 'Agent Steward' -srcfolder "$work_dir/payload" -fs HFS+ -format UDZO -ov "$out"
if [[ -n "$identity" ]]; then
  codesign --sign "$identity" --timestamp "$out"
fi

if "$notarize"; then
  # Keep credentials out of diagnostics; parse notarytool's machine-readable result.
  submission_ok=true
  xcrun notarytool submit "$out" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" \
    --issuer "$APPLE_API_ISSUER" --wait --timeout 30m --output-format json >"$work_dir/submission.json" || submission_ok=false
  status=$(plutil -extract status raw -o - "$work_dir/submission.json" 2>/dev/null) || status=''
  submission_id=$(plutil -extract id raw -o - "$work_dir/submission.json" 2>/dev/null) || submission_id=''
  if ! "$submission_ok" || [[ "$status" != Accepted ]]; then
    if [[ -n "$submission_id" ]]; then
      xcrun notarytool log "$submission_id" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" \
        --issuer "$APPLE_API_ISSUER" || printf 'Could not retrieve notarization log.\n' >&2
    else
      printf 'No submission ID returned; notarization log is unavailable.\n' >&2
    fi
    fail 'DMG notarization did not return Accepted; see notarytool diagnostics above'
  fi
  xcrun stapler staple "$out"
  xcrun stapler validate "$out"
  assessment=$(spctl -a -vv -t exec "$app" 2>&1) || { printf '%s\n' "$assessment" >&2; fail 'App Gatekeeper assessment failed'; }
  printf '%s\n' "$assessment"
  grep -Eq ': accepted$' <<<"$assessment" || fail 'App Gatekeeper result must be accepted'
  grep -Eq '^source=Notarized Developer ID$' <<<"$assessment" || fail 'App Gatekeeper source must be Notarized Developer ID'
  assessment=$(spctl -a -t open --context context:primary-signature -v "$out" 2>&1) || { printf '%s\n' "$assessment" >&2; fail 'DMG Gatekeeper assessment failed'; }
  printf '%s\n' "$assessment"
  grep -Eq ': accepted$' <<<"$assessment" || fail 'DMG Gatekeeper result must be accepted'
fi

printf 'Created DMG: %s\n' "$out"
