using System.Text.Json.Serialization;

namespace Checkpoint.Api.Models;

/// <summary>
/// Source-generated JSON context so the client works without runtime reflection (safe under
/// trimming, and cheaper when loaded inside the Horde server).
/// </summary>
[JsonSourceGenerationOptions(
	PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
	DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
	UseStringEnumConverter = true)]
[JsonSerializable(typeof(ServerVersionInfo))]
[JsonSerializable(typeof(UserInfo))]
[JsonSerializable(typeof(OrgInfo))]
[JsonSerializable(typeof(List<RepoInfo>))]
[JsonSerializable(typeof(RepoInfo))]
[JsonSerializable(typeof(BranchInfo))]
[JsonSerializable(typeof(List<BranchInfo>))]
[JsonSerializable(typeof(ChangelistInfo))]
[JsonSerializable(typeof(List<ChangelistInfo>))]
[JsonSerializable(typeof(List<ChangelistFileInfo>))]
[JsonSerializable(typeof(FileContentInfo))]
[JsonSerializable(typeof(ChangedPathsInfo))]
[JsonSerializable(typeof(List<ArtifactFileInfo>))]
[JsonSerializable(typeof(ArtifactSetInfo))]
[JsonSerializable(typeof(List<int>))]
public sealed partial class CheckpointJsonContext : JsonSerializerContext
{
}
