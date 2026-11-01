#!/usr/bin/env bash
# Downloads the Node the app carries -- exactly the version and checksum
# pinned in app/node.version -- and leaves its executable at OUT.
#
#   tools/app/fetch-node.sh OUT
#
# Pinned, never "latest LTS": a new Node is a new runtime under the party,
# and it changes when someone chooses to change that file, not on its own.
# Apple chips only (darwin-arm64), by choice.
set -euo pipefail
OUT="$1"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
read -r VERSION SHA < "$ROOT/app/node.version"
NAME="node-$VERSION-darwin-arm64"
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT

curl -fsSL --retry 3 -o "$DIR/$NAME.tar.gz" "https://nodejs.org/dist/$VERSION/$NAME.tar.gz"
echo "$SHA  $DIR/$NAME.tar.gz" | shasum -a 256 -c -          # refuses anything but the pinned build
tar -xzf "$DIR/$NAME.tar.gz" -C "$DIR"
mkdir -p "$(dirname "$OUT")"
cp "$DIR/$NAME/bin/node" "$OUT"
cp "$DIR/$NAME/LICENSE" "$(dirname "$OUT")/node-LICENSE"
chmod 755 "$OUT"
"$OUT" --version
