// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

using System;
using System.IO;
using UnrealBuildTool;

public class CheckpointSourceControl : ModuleRules
{
  public CheckpointSourceControl(ReadOnlyTargetRules Target) : base(Target)
  {
    String LibraryDirectory = Path.Combine(PluginDirectory, "Source", "ThirdParty", "CheckpointLibrary");

    PublicIncludePaths.AddRange(
      new string[]{
        LibraryDirectory
      }
    );

    PrivateDependencyModuleNames.AddRange(
      new string[] {
        "Core",
        "CoreUObject",
        "Slate",
        "SlateCore",
        "InputCore",
        "DesktopWidgets",
        "EditorStyle",
        "UnrealEd",
        "SourceControl",
        "SourceControlWindows",
        "Projects"
      }
    );

    if (Target.Version.MajorVersion == 5)
    {
      PrivateDependencyModuleNames.Add("ToolMenus");
    }

    string name = "LongtailWrapper";

    if (Target.Platform == UnrealTargetPlatform.Win64) {
      PublicDelayLoadDLLs.Add(name + ".dll");

      String subDir = "win64";
      String libPath = Path.Combine(LibraryDirectory, subDir, name + ".lib");
      String dllPath = Path.Combine(LibraryDirectory, subDir, name + ".dll");

      PublicAdditionalLibraries.Add(libPath);

      RuntimeDependencies.Add("$(TargetOutputDir)/cpr.dll", Path.Combine(LibraryDirectory, subDir, "cpr.dll"));
      RuntimeDependencies.Add("$(TargetOutputDir)/libcurl-d.dll", Path.Combine(LibraryDirectory, subDir, "libcurl-d.dll"));
      RuntimeDependencies.Add("$(TargetOutputDir)/longtail.dll", Path.Combine(LibraryDirectory, subDir, "longtail.dll"));
      RuntimeDependencies.Add("$(TargetOutputDir)/zlib.dll", Path.Combine(LibraryDirectory, subDir, "zlib.dll"));
    } else if (Target.Platform == UnrealTargetPlatform.Linux) {
      PublicDelayLoadDLLs.Add(name + ".so");

      String subDir = "linux";
      String libPath = Path.Combine(LibraryDirectory, subDir, name + ".so");
      PublicAdditionalLibraries.Add(libPath);
    } else if (Target.Platform == UnrealTargetPlatform.Mac) {
      PublicDelayLoadDLLs.Add(name + ".dylib");

      String subDir = "mac";
      String libPath = Path.Combine(LibraryDirectory, subDir, name + ".dylib");
      PublicAdditionalLibraries.Add(libPath);
    }
  }
}
