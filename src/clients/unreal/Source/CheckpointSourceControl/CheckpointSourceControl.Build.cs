// Copyright Incanta Games. All Rights Reserved.

using System;
using System.IO;
using UnrealBuildTool;

public class CheckpointSourceControl : ModuleRules
{
  public CheckpointSourceControl(ReadOnlyTargetRules Target) : base(Target)
  {
    PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

    PrivateDependencyModuleNames.AddRange(
      new string[] {
        "Core",
        "CoreUObject",
        "SourceControl",
        "Engine",
        "HTTP",
        "Json",
        "JsonUtilities",
      }
    );

    if (Target.bUsesSlate)
    {
      PrivateDependencyModuleNames.AddRange(
        new string[] {
          "InputCore",
          "Slate",
          "SlateCore",
        }
      );
    }
  }
}
