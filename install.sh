#!/bin/sh
# Installs or updates pasode from its GitHub releases; rerun it to update.
#   curl -fsSL https://raw.githubusercontent.com/ragokan/pasode/main/install.sh | sh
# PASODE_INSTALL_DIR: where pasode goes (default ~/.local/bin). PASODE_VERSION: a release to pin, e.g. 0.4.0 (default latest).
set -eu

releases=${PASODE_RELEASES:-https://github.com/ragokan/pasode/releases} # overridable for tests and mirrors
dir=${PASODE_INSTALL_DIR:-$HOME/.local/bin}

fail() {
  echo "pasode install: $*" >&2
  exit 1
}

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "no pasode build for $(uname -s)" ;;
esac
case $(uname -m) in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "no pasode build for $(uname -m)" ;;
esac
asset=pasode-$os-$arch.gz

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1"; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1"; }
else
  fail "sha256sum or shasum is required"
fi

# Resolve "latest" to its tag first, so the binary and SHA256SUMS come from the same release.
if [ -n "${PASODE_VERSION:-}" ]; then
  tag=v${PASODE_VERSION#v}
else
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest") || fail "couldn't reach $releases"
  tag=${tag##*/}
fi
case $tag in
  v[0-9]*) ;;
  *) fail "couldn't find the latest release at $releases" ;;
esac

tmp=$(mktemp -d)
part=$dir/.pasode.$$
trap 'rm -rf "$tmp"; rm -f "$part"' EXIT
curl -fsSL -o "$tmp/$asset" "$releases/download/$tag/$asset" || fail "couldn't download $asset of $tag"
curl -fsSL -o "$tmp/SHA256SUMS" "$releases/download/$tag/SHA256SUMS" || fail "couldn't download SHA256SUMS of $tag"
expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$tmp/SHA256SUMS")
actual=$(sha256 "$tmp/$asset" | awk '{ print $1 }')
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "$asset doesn't match the SHA256SUMS of $tag"

# Unpack next to the target, then rename over it: a running pasode keeps its file, and macOS never sees a
# signed binary change in place.
mkdir -p "$dir" || fail "couldn't create $dir"
{ gunzip -c "$tmp/$asset" >"$part" && chmod 755 "$part" && mv -f "$part" "$dir/pasode"; } || fail "couldn't write $dir/pasode"
echo "pasode ${tag#v} installed to $dir/pasode"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "pasode install: $dir is not on your PATH; add it, e.g. export PATH=\"$dir:\$PATH\"" >&2 ;;
esac
