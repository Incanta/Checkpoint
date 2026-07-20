#!/usr/bin/env bash
# Builds the Checkpoint Horde integration (server plugin + API client).
# Requires HORDE_ENGINE_DIR to point at an Unreal Engine checkout root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGURATION="${CONFIGURATION:-Release}"

if [[ -z "${HORDE_ENGINE_DIR:-}" ]]; then
  echo "HORDE_ENGINE_DIR is required (path to an Unreal Engine checkout root)" >&2
  exit 1
fi
if [[ ! -d "$HORDE_ENGINE_DIR/Engine/Source/Programs/Horde" ]]; then
  echo "No Horde source found under '$HORDE_ENGINE_DIR'" >&2
  exit 1
fi

DOTNET="${DOTNET:-dotnet}"
if ! "$DOTNET" --list-sdks 2>/dev/null | grep -qE '^1[0-9]\.'; then
  for candidate in "$HORDE_ENGINE_DIR"/Engine/Binaries/ThirdParty/DotNet/10.0/*/dotnet; do
    if [[ -x "$candidate" ]]; then
      DOTNET="$candidate"
      break
    fi
  done
fi

echo "Using dotnet: $DOTNET"
"$DOTNET" build "$ROOT/src/HordeServer.Checkpoint/HordeServer.Checkpoint.csproj" -c "$CONFIGURATION"

OUT_DIR="$ROOT/artifacts/server"
BIN_DIR="$ROOT/src/HordeServer.Checkpoint/bin/$CONFIGURATION/net10.0"
mkdir -p "$OUT_DIR"
cp "$BIN_DIR/HordeServer.Checkpoint.dll" "$BIN_DIR/Checkpoint.Api.dll" "$OUT_DIR/"
echo "Server plugin artifacts written to $OUT_DIR"
