using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using Checkpoint.Api.Models;

namespace Checkpoint.Api;

/// <summary>
/// Typed client for the Checkpoint app server's tRPC API. Wraps the procedures a build/CI
/// integration needs: repo/branch resolution, changelist listing and tailing, file content
/// at a revision, and artifact attachment.
/// </summary>
public class CheckpointClient
{
	readonly TrpcHttpClient _trpc;

	public CheckpointClient(HttpClient httpClient, CheckpointClientOptions options)
		: this(new TrpcHttpClient(httpClient, options))
	{
	}

	public CheckpointClient(TrpcHttpClient trpc)
	{
		_trpc = trpc;
	}

	/// <summary>
	/// Endpoint this client talks to, for diagnostics.
	/// </summary>
	public Uri BaseUri => _trpc.BaseUri;

	// ---- Connectivity / identity ----

	public async Task<ServerVersionInfo> GetServerVersionAsync(CancellationToken cancellationToken = default)
	{
		JsonNode? result = await _trpc.QueryAsync("version.current", null, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ServerVersionInfo, "version.current");
	}

	public async Task<UserInfo> GetMeAsync(CancellationToken cancellationToken = default)
	{
		JsonNode? result = await _trpc.QueryAsync("user.me", null, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.UserInfo, "user.me");
	}

	// ---- Org / repo / branch resolution ----

	public async Task<OrgInfo?> GetOrgAsync(string idOrName, bool idIsName = false, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["id"] = idOrName,
			["idIsName"] = idIsName,
			["includeUsers"] = false,
		};
		JsonNode? result = await _trpc.QueryAsync("org.getOrg", input, null, cancellationToken);
		return DeserializeOrNull(result, CheckpointJsonContext.Default.OrgInfo);
	}

	public async Task<List<RepoInfo>> ListReposAsync(string orgId, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject { ["orgId"] = orgId };
		JsonNode? result = await _trpc.QueryAsync("repo.list", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ListRepoInfo, "repo.list");
	}

	public async Task<RepoInfo?> GetRepoAsync(string repoId, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject { ["id"] = repoId };
		JsonNode? result = await _trpc.QueryAsync("repo.getRepo", input, null, cancellationToken);
		return DeserializeOrNull(result, CheckpointJsonContext.Default.RepoInfo);
	}

	public async Task<BranchInfo?> GetBranchAsync(string repoId, string name, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject { ["repoId"] = repoId, ["name"] = name };
		JsonNode? result = await _trpc.QueryAsync("branch.getBranch", input, null, cancellationToken);
		return DeserializeOrNull(result, CheckpointJsonContext.Default.BranchInfo);
	}

	public async Task<List<BranchInfo>> ListBranchesAsync(string repoId, bool includeArchived = false, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject { ["repoId"] = repoId, ["includeArchived"] = includeArchived };
		JsonNode? result = await _trpc.QueryAsync("branch.listBranches", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ListBranchInfo, "branch.listBranches");
	}

	/// <summary>
	/// Resolves an "org/repo" pair (by name) to a repo id.
	/// </summary>
	public async Task<string?> ResolveRepoIdAsync(string orgName, string repoName, CancellationToken cancellationToken = default)
	{
		OrgInfo? org = await GetOrgAsync(orgName, idIsName: true, cancellationToken);
		return org?.Repos.FirstOrDefault(repo => String.Equals(repo.Name, repoName, StringComparison.OrdinalIgnoreCase))?.Id;
	}

	// ---- Changelists ----

	/// <summary>
	/// Lists changelists newest-first by walking the parentNumber chain. When
	/// <paramref name="startNumber"/> is null the walk starts at the branch head; otherwise it starts
	/// at that changelist (inclusive). Count must be 1-100.
	/// </summary>
	public async Task<List<ChangelistInfo>> GetChangelistsAsync(string repoId, string branchName, int? startNumber, int count, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["branchName"] = branchName,
			["start"] = new JsonObject { ["number"] = startNumber, ["timestamp"] = null },
			["count"] = count,
		};
		JsonNode? result = await _trpc.QueryAsync("changelist.getChangelists", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ListChangelistInfo, "changelist.getChangelists");
	}

	public async Task<ChangelistInfo?> GetChangelistAsync(string repoId, int changelistNumber, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject { ["repoId"] = repoId, ["changelistNumber"] = changelistNumber };
		JsonNode? result = await _trpc.QueryAsync("changelist.getChangelist", input, null, cancellationToken);
		return DeserializeOrNull(result, CheckpointJsonContext.Default.ChangelistInfo);
	}

	public async Task<List<ChangelistInfo>> GetChangelistsWithNumbersAsync(string repoId, IEnumerable<int> numbers, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["numbers"] = new JsonArray(numbers.Select(n => (JsonNode)n).ToArray()),
		};
		JsonNode? result = await _trpc.MutateAsync("changelist.getChangelistsWithNumbers", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ListChangelistInfo, "changelist.getChangelistsWithNumbers");
	}

	public async Task<List<ChangelistFileInfo>> GetChangelistFilesAsync(string repoId, int changelistNumber, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject { ["repoId"] = repoId, ["changelistNumber"] = changelistNumber };
		JsonNode? result = await _trpc.QueryAsync("changelist.getChangelistFiles", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ListChangelistFileInfo, "changelist.getChangelistFiles");
	}

	/// <summary>
	/// Paths changed in the range (fromNumber, toNumber] (from exclusive, to inclusive).
	/// </summary>
	public async Task<List<string>> GetFilePathsChangedBetweenAsync(string repoId, int fromNumber, int toNumber, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["fromNumber"] = fromNumber,
			["toNumber"] = toNumber,
		};
		JsonNode? result = await _trpc.QueryAsync("changelist.getFilePathsChangedBetween", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ChangedPathsInfo, "changelist.getFilePathsChangedBetween").Paths;
	}

	/// <summary>
	/// Head changelist number for a branch, or null when the branch does not exist.
	/// </summary>
	public async Task<int?> GetHeadNumberAsync(string repoId, string branchName, CancellationToken cancellationToken = default)
	{
		BranchInfo? branch = await GetBranchAsync(repoId, branchName, cancellationToken);
		return branch?.HeadNumber;
	}

	/// <summary>
	/// Returns all changelists on the branch with number &gt; <paramref name="sinceNumber"/>, oldest
	/// first, following the branch's parentNumber chain. <paramref name="maxResults"/> caps the walk;
	/// when the cap is hit, the NEWEST <paramref name="maxResults"/> entries are returned.
	/// </summary>
	public async Task<List<ChangelistInfo>> GetChangelistsSinceAsync(string repoId, string branchName, int sinceNumber, int maxResults = 1000, CancellationToken cancellationToken = default)
	{
		List<ChangelistInfo> collected = new List<ChangelistInfo>();

		int? start = null;
		while (collected.Count < maxResults)
		{
			int batchSize = Math.Min(100, maxResults - collected.Count);
			List<ChangelistInfo> page = await GetChangelistsAsync(repoId, branchName, start, batchSize, cancellationToken);
			if (page.Count == 0)
			{
				break;
			}

			// Pages after the first start at the previous page's parent, so the start entry is not a duplicate
			bool done = false;
			foreach (ChangelistInfo changelist in page)
			{
				if (changelist.Number <= sinceNumber)
				{
					done = true;
					break;
				}
				collected.Add(changelist);
			}

			ChangelistInfo last = page[^1];
			if (done || last.ParentNumber == null || page.Count < batchSize)
			{
				break;
			}
			start = last.ParentNumber;
		}

		collected.Reverse();
		return collected;
	}

	// ---- File content ----

	public async Task<FileContentInfo> ReadFileContentAsync(string repoId, int changelistNumber, string filePath, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["changelistNumber"] = changelistNumber,
			["filePath"] = filePath,
		};
		JsonNode? result = await _trpc.QueryAsync("file.readFileContent", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.FileContentInfo, "file.readFileContent");
	}

	// ---- Artifacts ----

	public async Task<List<ArtifactFileInfo>> ListArtifactsAsync(string repoId, int changelistNumber, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject { ["repoId"] = repoId, ["changelistNumber"] = changelistNumber };
		JsonNode? result = await _trpc.QueryAsync("artifact.list", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ListArtifactFileInfo, "artifact.list");
	}

	/// <summary>
	/// Changelist numbers (of the given set) that have artifacts attached.
	/// </summary>
	public async Task<List<int>> GetArtifactChangelistsAsync(string repoId, IEnumerable<int> changelistNumbers, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["changelistNumbers"] = new JsonArray(changelistNumbers.Select(n => (JsonNode)n).ToArray()),
		};
		JsonNode? result = await _trpc.QueryAsync("artifact.getForChangelists", input, null, cancellationToken);
		return Deserialize(result, CheckpointJsonContext.Default.ListInt32, "artifact.getForChangelists");
	}

	/// <summary>
	/// Merges an artifact set (additive overwrite) into a changelist for the given channel
	/// <paramref name="type"/> (defaults to "editor"). Each modification either adds/overwrites
	/// a path or deletes it.
	/// </summary>
	public async Task AttachArtifactSetAsync(string repoId, int changelistNumber, string versionIndex, string type, IEnumerable<ArtifactModification> modifications, CancellationToken cancellationToken = default)
	{
		JsonArray mods = new JsonArray();
		foreach (ArtifactModification mod in modifications)
		{
			JsonObject modObj = new JsonObject
			{
				["delete"] = mod.Delete,
				["path"] = mod.Path,
			};
			if (mod.OldPath != null)
			{
				modObj["oldPath"] = mod.OldPath;
			}
			mods.Add(modObj);
		}

		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["changelistNumber"] = changelistNumber,
			["versionIndex"] = versionIndex,
			["type"] = type,
			["modifications"] = mods,
		};
		await _trpc.MutateAsync("artifact.attachToChangelist", input, null, cancellationToken);
	}

	/// <summary>
	/// Newest artifact set of <paramref name="type"/> at or before <paramref name="maxChangelistNumber"/>
	/// on the ancestor chain, optionally gated on <paramref name="requiredBadges"/> being SUCCESS at the
	/// set's changelist. Returns null when no matching set is found.
	/// </summary>
	public async Task<ArtifactSetInfo?> FindLatestArtifactSetAsync(string repoId, string type, int maxChangelistNumber, IReadOnlyList<string>? requiredBadges = null, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["type"] = type,
			["maxChangelistNumber"] = maxChangelistNumber,
		};
		if (requiredBadges != null)
		{
			input["requiredBadges"] = new JsonArray(requiredBadges.Select(b => (JsonNode)b).ToArray());
		}
		JsonNode? result = await _trpc.QueryAsync("artifact.findLatestSet", input, null, cancellationToken);
		return DeserializeOrNull(result, CheckpointJsonContext.Default.ArtifactSetInfo);
	}

	// ---- Build badges ----

	/// <summary>
	/// Posts (upserts) a single build badge for a changelist. <paramref name="state"/> is one of
	/// "STARTING", "FAILURE", "WARNING", "SUCCESS", or "SKIPPED".
	/// </summary>
	public async Task PostBadgeAsync(string repoId, int changelistNumber, string name, string state, string? group = null, string? url = null, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["changelistNumber"] = changelistNumber,
			["name"] = name,
			["state"] = state,
		};
		if (group != null)
		{
			input["group"] = group;
		}
		if (url != null)
		{
			input["url"] = url;
		}
		await _trpc.MutateAsync("buildBadge.post", input, null, cancellationToken);
	}

	/// <summary>
	/// Posts (upserts) many build badges at once. Returns the number of badges written (changelists
	/// that do not exist are skipped by the server).
	/// </summary>
	public async Task<int> PostBadgesAsync(string repoId, IEnumerable<BadgeInput> badges, CancellationToken cancellationToken = default)
	{
		JsonArray badgeArray = new JsonArray();
		foreach (BadgeInput badge in badges)
		{
			JsonObject badgeObj = new JsonObject
			{
				["changelistNumber"] = badge.ChangelistNumber,
				["name"] = badge.Name,
				["state"] = badge.State,
			};
			if (badge.Group != null)
			{
				badgeObj["group"] = badge.Group;
			}
			if (badge.Url != null)
			{
				badgeObj["url"] = badge.Url;
			}
			badgeArray.Add(badgeObj);
		}

		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["badges"] = badgeArray,
		};
		JsonNode? result = await _trpc.MutateAsync("buildBadge.postBatch", input, null, cancellationToken);
		return result?["count"]?.GetValue<int>() ?? 0;
	}

	/// <summary>
	/// Newest changelist at or before <paramref name="startNumber"/> whose <paramref name="requiredBadges"/>
	/// are all SUCCESS. Returns null when none qualify. At least one required badge must be supplied.
	/// </summary>
	public async Task<int?> FindLatestGoodChangelistAsync(string repoId, int startNumber, IReadOnlyList<string> requiredBadges, CancellationToken cancellationToken = default)
	{
		JsonObject input = new JsonObject
		{
			["repoId"] = repoId,
			["startNumber"] = startNumber,
			["requiredBadges"] = new JsonArray(requiredBadges.Select(b => (JsonNode)b).ToArray()),
		};
		JsonNode? result = await _trpc.QueryAsync("buildBadge.findLatestGood", input, null, cancellationToken);
		return result?["changelistNumber"]?.GetValue<int>();
	}

	// ---- Helpers ----

	static T Deserialize<T>(JsonNode? node, JsonTypeInfo<T> typeInfo, string procedure)
	{
		T? value = node.Deserialize(typeInfo);
		if (value == null)
		{
			throw new TrpcException($"Checkpoint server returned an unexpected null payload", procedure: procedure);
		}
		return value;
	}

	static T? DeserializeOrNull<T>(JsonNode? node, JsonTypeInfo<T> typeInfo) where T : class
	{
		return node == null ? null : node.Deserialize(typeInfo);
	}
}
