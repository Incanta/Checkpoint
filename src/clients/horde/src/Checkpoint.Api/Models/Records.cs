using System.Text.Json;
using System.Text.Json.Serialization;

namespace Checkpoint.Api.Models;

/// <summary>
/// Response of version.current. Public procedure; also used as a connectivity probe.
/// </summary>
public sealed record ServerVersionInfo
{
	public string ServerVersion { get; init; } = String.Empty;
	public int ServerApi { get; init; }
	public int MinServerApi { get; init; }
}

/// <summary>
/// Response of user.me (subset). Used to validate credentials and identify the service account.
/// </summary>
public sealed record UserInfo
{
	public string Id { get; init; } = String.Empty;
	public string Email { get; init; } = String.Empty;
	public string? Name { get; init; }
	public string? Username { get; init; }
}

/// <summary>
/// Repo summary as returned inside org.getOrg.
/// </summary>
public sealed record OrgRepoInfo
{
	public string Id { get; init; } = String.Empty;
	public string Name { get; init; } = String.Empty;
	public bool Public { get; init; }
}

/// <summary>
/// Response of org.getOrg (subset).
/// </summary>
public sealed record OrgInfo
{
	public string Id { get; init; } = String.Empty;
	public string Name { get; init; } = String.Empty;
	public List<OrgRepoInfo> Repos { get; init; } = new();
}

/// <summary>
/// Repo model (subset). storageBytes is a Prisma BigInt, which superjson serializes as a string.
/// </summary>
public sealed record RepoInfo
{
	public string Id { get; init; } = String.Empty;
	public string Name { get; init; } = String.Empty;
	public string OrgId { get; init; } = String.Empty;
	public bool Public { get; init; }

	[JsonConverter(typeof(FlexibleLongConverter))]
	public long StorageBytes { get; init; }
}

/// <summary>
/// Branch model as returned by branch.getBranch/listBranches.
/// </summary>
public sealed record BranchInfo
{
	public string Id { get; init; } = String.Empty;
	public string RepoId { get; init; } = String.Empty;
	public string Name { get; init; } = String.Empty;
	public int HeadNumber { get; init; }
	public bool IsDefault { get; init; }
	public BranchKind Type { get; init; }
	public DateTime? ArchivedAt { get; init; }
	public string? ParentBranchName { get; init; }
}

/// <summary>
/// Author info included on changelist queries.
/// </summary>
public sealed record ChangelistAuthor
{
	public string Id { get; init; } = String.Empty;
	public string Email { get; init; } = String.Empty;
	public string? Name { get; init; }
	public string? Username { get; init; }
}

/// <summary>
/// Changelist model as returned by changelist.getChangelist(s). Numbers are monotonic per repo;
/// per-branch history is the parentNumber chain.
/// </summary>
public sealed record ChangelistInfo
{
	public string Id { get; init; } = String.Empty;
	public DateTime CreatedAt { get; init; }
	public int Number { get; init; }
	public string Message { get; init; } = String.Empty;
	public string VersionIndex { get; init; } = String.Empty;
	public string? StateRootHash { get; init; }
	public string? ArtifactVersionIndex { get; init; }
	public string RepoId { get; init; } = String.Empty;
	public string? UserId { get; init; }
	public int? ParentNumber { get; init; }
	public ChangelistAuthor? User { get; init; }
}

/// <summary>
/// One file change inside a changelist, as returned by changelist.getChangelistFiles.
/// </summary>
public sealed record ChangelistFileInfo
{
	public string Id { get; init; } = String.Empty;
	public string FileId { get; init; } = String.Empty;
	public string Path { get; init; } = String.Empty;
	public FileChangeKind ChangeType { get; init; }
	public string? OldPath { get; init; }
}

/// <summary>
/// Response of file.readFileContent. Binary files return Content = null with IsBinary = true;
/// oversized text files return Content = null with TooLarge = true.
/// </summary>
public sealed record FileContentInfo
{
	public string? Content { get; init; }
	public bool IsBinary { get; init; }
	public long Size { get; init; }
	public bool? TooLarge { get; init; }
}

/// <summary>
/// Response of changelist.getFilePathsChangedBetween.
/// </summary>
public sealed record ChangedPathsInfo
{
	public List<string> Paths { get; init; } = new();
}

/// <summary>
/// One artifact file attached to a changelist, as returned by artifact.list.
/// </summary>
public sealed record ArtifactFileInfo
{
	public string Id { get; init; } = String.Empty;
	public string FileId { get; init; } = String.Empty;
	public string Path { get; init; } = String.Empty;
	public long Size { get; init; }
	public DateTime CreatedAt { get; init; }
}

/// <summary>
/// Reads a long from either a JSON number or a string token (superjson bigint fields arrive as strings).
/// </summary>
public sealed class FlexibleLongConverter : JsonConverter<long>
{
	public override long Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
	{
		if (reader.TokenType == JsonTokenType.String)
		{
			return Int64.Parse(reader.GetString()!, System.Globalization.CultureInfo.InvariantCulture);
		}
		return reader.GetInt64();
	}

	public override void Write(Utf8JsonWriter writer, long value, JsonSerializerOptions options)
	{
		writer.WriteNumberValue(value);
	}
}
