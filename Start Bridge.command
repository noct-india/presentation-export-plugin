#!/bin/bash
# Double-click this to start the Presentation Export bridge. Nothing to
# remember, nothing to type.
#
# A .command launched from Finder does not always inherit the PATH you get in
# a normal terminal, so node is located explicitly below rather than assumed.
# That is the difference between this working on one machine and working on
# everyone's. (Same approach as the Design System Documentation plugin's
# "Start Claude bridge.command" — ported here for this bridge.)

set -u

PORT="${PRESENTATION_BRIDGE_PORT:-3001}"

# ─── Locate ourselves ────────────────────────────────────────────────────────
# Follow symlinks, so a Finder alias or a symlink on the Desktop still finds
# the server next to the real file.
target="${BASH_SOURCE[0]}"
while [ -L "$target" ]; do
  dir="$(cd -P "$(dirname "$target")" && pwd)"
  target="$(readlink "$target")"
  [[ "$target" != /* ]] && target="$dir/$target"
done
HERE="$(cd -P "$(dirname "$target")" && pwd)"
cd "$HERE" || exit 1

printf '\033]0;Presentation Export bridge\007'   # window title

if [ ! -f "bridge/server.mjs" ]; then
  echo "Can't find bridge/server.mjs next to this shortcut."
  echo "Expected it in: $HERE/bridge"
  echo
  echo "Keep this file in the plugin folder, or use an alias rather than a copy."
  read -r -p "Press return to close… " _
  exit 1
fi

# ─── Find node ───────────────────────────────────────────────────────────────
# Homebrew on Apple silicon and on Intel, a user-local bin, and the two
# version managers people actually use.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
command -v fnm >/dev/null 2>&1 && eval "$(fnm env 2>/dev/null)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node isn't installed, or isn't on the PATH this window can see."
  echo
  echo "Install it from https://nodejs.org (the LTS build is fine), then try again."
  read -r -p "Press return to close… " _
  exit 1
fi

# ─── Check the port is free ──────────────────────────────────────────────────
# A bridge left running from an earlier session holds the port and the new
# one silently never binds. Name it and offer to stop it.
holder="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
if [ -n "$holder" ]; then
  echo "Something is already listening on port $PORT:"
  echo
  ps -o pid=,etime=,command= -p "$holder" 2>/dev/null | sed 's/^/    /'
  echo
  if [ -t 0 ]; then
    read -r -p "Stop it and start fresh? [y/N] " answer
    case "$answer" in
      [Yy]*)
        kill "$holder" 2>/dev/null
        sleep 1
        if lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
          echo "It didn't stop. Close that window yourself, then run this again."
          read -r -p "Press return to close… " _
          exit 1
        fi
        echo "Stopped."
        ;;
      *)
        echo "Leaving it alone — that one is probably the bridge you want."
        read -r -p "Press return to close… " _
        exit 0
        ;;
    esac
  else
    echo "Close it first, or set PRESENTATION_BRIDGE_PORT to a different port."
    exit 1
  fi
  echo
fi

echo "Starting the Presentation Export bridge on port $PORT."
echo "Leave this window open while you publish from Figma. Press Control-C to stop it."
echo "────────────────────────────────────────────────────────────────"
echo

node bridge/server.mjs
status=$?

echo
if [ "$status" -eq 0 ] || [ "$status" -eq 130 ]; then
  echo "Bridge stopped."
else
  echo "Bridge exited unexpectedly (code $status). The messages above say why."
  [ -t 0 ] && read -r -p "Press return to close… " _
fi
