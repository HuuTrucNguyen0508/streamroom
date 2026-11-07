#!/usr/bin/env bash
set -euo pipefail
command -v pactl >/dev/null || { echo 'Install pactl (pulseaudio-utils) first.' >&2; exit 1; }
state_dir="${XDG_RUNTIME_DIR:-/tmp/streamroom-$UID}/streamroom-game-audio"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
exec 9>"$state_dir/lock"
flock 9
state="$state_dir/modules"
# Store complete module lines, so teardown never unloads a reused numeric ID.
remove_owned() {
  [[ -f "$state" ]] || return 0
  mapfile -t owned < "$state"
  for (( i=${#owned[@]}-1; i>=0; i-- )); do
    line="${owned[i]}"
    id="${line%%$'\t'*}"
    if pactl list short modules | awk -F '\t' -v id="$id" '$1 == id' | cmp -s - <(printf '%s\n' "$line"); then
      pactl unload-module "$id"
      echo "Removed module $id"
    fi
  done
  rm -f "$state"
}
load_owned() {
  local id
  id=$(pactl load-module "$@")
  pactl list short modules | awk -F '\t' -v id="$id" '$1 == id' >> "$state"
  echo "Created $1 module $id"
}
case "${1:-status}" in
  setup)
    if [[ -s "$state" ]]; then
      echo 'Streamroom audio is already configured. Use status, or teardown before setup.'
      exit 0
    fi
    if pactl list short sinks | awk '{print $2}' | grep -qx streamroom_game || pactl list short sources | awk '{print $2}' | grep -qx streamroom_game_audio; then
      echo 'A Streamroom audio name already exists without our ownership record; refusing to change it.' >&2
      exit 1
    fi
    default_sink=$(pactl get-default-sink)
    trap 'remove_owned' ERR
    load_owned module-null-sink sink_name=streamroom_game "sink_properties='device.description=\"Streamroom Game\"'" rate=48000 channels=2
    load_owned module-remap-source master=streamroom_game.monitor source_name=streamroom_game_audio "source_properties='device.description=\"Streamroom Game Audio\"'" channels=2 remix=no
    load_owned module-loopback source=streamroom_game.monitor sink="$default_sink" latency_msec=30 source_dont_move=true sink_dont_move=true
    trap - ERR
    echo 'Route ONLY your game to "Streamroom Game" in pavucontrol (Playback) or KDE audio settings.'
    echo 'In Streamroom, choose Audio source > Streamroom Game Audio. Leave browser/voice output on your normal speakers or headphones.'
    ;;
  teardown) remove_owned; echo 'Streamroom game audio removed.' ;;
  status)
    if [[ -s "$state" ]]; then cat "$state"; else echo 'Streamroom game audio is not configured.'; fi
    pactl list short sinks
    pactl list short sources
    ;;
  *) echo "Usage: $0 setup|teardown|status" >&2; exit 2 ;;
esac
