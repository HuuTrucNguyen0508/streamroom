#!/usr/bin/env bash
# Renders the app icons in src/web/public from icon.svg. Run it after changing icon.svg.
# Needs resvg and ImageMagick (magick).
set -euo pipefail
cd "$(dirname "$0")/../src/web/public"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Windows, Chrome and Edge show these as they are: the art with no plate.
for size in 48 64 96 128 192 256 512; do
  resvg -w "$size" -h "$size" icon.svg "icon-$size.png"
done

# Android and iOS crop icons to their own shape, so these put the art on a full-bleed ink plate,
# inside the central safe circle.
plate() { # plate SIZE OUT
  local art=$(( $1 * 5 / 8 ))
  resvg -w "$art" -h "$art" icon.svg "$tmp/art.png"
  magick -size "$1x$1" xc:'#15132a' "$tmp/art.png" -gravity center -geometry +0+$(( $1 / 128 )) -composite -strip "$2"
}
plate 192 icon-maskable-192.png
plate 512 icon-maskable-512.png
plate 180 apple-touch-icon.png
