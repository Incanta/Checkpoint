using Checkpoint.Api;
using Checkpoint.Api.Models;
using Xunit;

namespace Checkpoint.Integration.Tests;

/// <summary>
/// Integration tests against a live Checkpoint dev server (start one with `node dev.js` at the repo
/// root). Skipped unless CHECKPOINT_TEST_ENDPOINT (e.g. http://localhost:13000) and
/// CHECKPOINT_TEST_TOKEN are set. Obtain a token via the auth.devLogin flow used by
/// .github/workflows/test.js, or create one in the web UI.
/// Optional: CHECKPOINT_TEST_REPO_ID / CHECKPOINT_TEST_BRANCH (default "main") select a repo with
/// at least one submitted changelist for the read tests.
/// </summary>
public class LiveServerTests
{
	static CheckpointClient? TryCreateClient()
	{
		string? endpoint = Environment.GetEnvironmentVariable("CHECKPOINT_TEST_ENDPOINT");
		string? token = Environment.GetEnvironmentVariable("CHECKPOINT_TEST_TOKEN");
		if (String.IsNullOrEmpty(endpoint) || String.IsNullOrEmpty(token))
		{
			return null;
		}
		CheckpointClientOptions options = new CheckpointClientOptions
		{
			Endpoint = new Uri(endpoint),
			Token = token,
		};
		return new CheckpointClient(new HttpClient(), options);
	}

	[SkippableFact]
	public async Task VersionAndAuth()
	{
		CheckpointClient? client = TryCreateClient();
		Skip.If(client == null, "CHECKPOINT_TEST_ENDPOINT/CHECKPOINT_TEST_TOKEN not set");

		ServerVersionInfo version = await client!.GetServerVersionAsync();
		Assert.False(String.IsNullOrEmpty(version.ServerVersion));

		UserInfo me = await client.GetMeAsync();
		Assert.False(String.IsNullOrEmpty(me.Email));
	}

	[SkippableFact]
	public async Task ChangelistPagingAndFiles()
	{
		CheckpointClient? client = TryCreateClient();
		Skip.If(client == null, "CHECKPOINT_TEST_ENDPOINT/CHECKPOINT_TEST_TOKEN not set");
		string? repoId = Environment.GetEnvironmentVariable("CHECKPOINT_TEST_REPO_ID");
		Skip.If(String.IsNullOrEmpty(repoId), "CHECKPOINT_TEST_REPO_ID not set");
		string branch = Environment.GetEnvironmentVariable("CHECKPOINT_TEST_BRANCH") ?? "main";

		int? head = await client!.GetHeadNumberAsync(repoId!, branch);
		Assert.NotNull(head);

		List<ChangelistInfo> latest = await client.GetChangelistsAsync(repoId!, branch, null, 10);
		Assert.NotEmpty(latest);
		Assert.Equal(head, latest[0].Number);

		List<ChangelistInfo> since = await client.GetChangelistsSinceAsync(repoId!, branch, sinceNumber: -1, maxResults: 200);
		Assert.True(since.Count > 0);
		Assert.True(since.SequenceEqual(since.OrderBy(x => x.Number)), "tail must be ascending");

		List<ChangelistFileInfo> files = await client.GetChangelistFilesAsync(repoId!, head!.Value);
		Assert.NotNull(files);
	}
}
