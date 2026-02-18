# only used in windows for cross compiling
export LINUX_MULTIARCH_ROOT=/c/UnrealToolchains/v26_clang-20.1.8-rockylinux8/
if [ "$(uname)" != "Darwin" ]; then
  ${LINUX_MULTIARCH_ROOT}x86_64-unknown-linux-gnu/bin/clang++ -v
fi

export ENGINE_VERSION=Incanta
export PLUGIN_NAME=CheckpointSourceControl

if [ "$(uname)" == "Darwin" ]; then
  UAT_PATH="/Users/Shared/Epic Games/UE_${ENGINE_VERSION}/Engine/Build/BatchFiles/RunUAT.sh"
  TARGET_PLATFORMS=Mac
else
  # windows handles linux cross compile
  UAT_PATH="/e/epic/engine/UE_${ENGINE_VERSION}/Engine/Build/BatchFiles/RunUAT.bat"
  TARGET_PLATFORMS=Win64+Linux
fi

"${UAT_PATH}" \
  BuildPlugin \
  -Plugin=$(pwd)/${PLUGIN_NAME}.uplugin \
  -Package=$(pwd)/Dist \
  -TargetPlatforms=${TARGET_PLATFORMS} \
  -Rocket \
  -VS2022 | sed 's/\\Dist\\HostProject\\Plugins\\CheckpointSourceControl//g'

rm -rf $(pwd)/Dist
