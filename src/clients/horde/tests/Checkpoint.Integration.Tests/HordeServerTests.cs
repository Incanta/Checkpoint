using System.Net;
using System.Text.Json;
using Checkpoint.Api;
using Checkpoint.Api.Models;
using Xunit;

namespace Checkpoint.Integration.Tests;

/// <summary>
/// End-to-end tests of the Horde server plugin: a real Horde server with HordeServer.Checkpoint
/// loaded, a stream configured with "vcs": "Checkpoint", and a live Checkpoint server behind it.
/// Horde's stream changes endpoints read commits through the stream's version control provider, so
/// every assertion here goes through the plugin (config binding, connection, repo resolution, the
/// commit collection, author mapping, and file-based commit tags), compared against what the
/// Checkpoint API itself reports.
///
/// .github/workflows/horde-integration.yaml sets all of this up. Skipped unless
/// HORDE_TEST_ENDPOINT (e.g. http://localhost:13340) and HORDE_TEST_STREAM_ID are set, along with
/// the CHECKPOINT_TEST_* variables LiveServerTests uses.
/// </summary>
public class HordeServerTests
{
	sealed record HordeChange(int Number, string Description, string? AuthorName, List<string> Tags, List<string> Files);

	sealed class Env
	{
		public required HttpClient Horde { get; init; }
		public required string StreamId { get; init; }
		public required CheckpointClient Checkpoint { get; init; }
		public required string RepoId { get; init; }
		public required string Branch { get; init; }
	}

	static Env Require()
	{
		string? hordeEndpoint = LiveTest.Env("HORDE_TEST_ENDPOINT");
		string? streamId = LiveTest.Env("HORDE_TEST_STREAM_ID");
		string? endpoint = LiveTest.Env("CHECKPOINT_TEST_ENDPOINT");
		string? token = LiveTest.Env("CHECKPOINT_TEST_TOKEN");
		string? repoId = LiveTest.Env("CHECKPOINT_TEST_REPO_ID");
		LiveTest.SkipIf(hordeEndpoint == null || streamId == null, "HORDE_TEST_ENDPOINT/HORDE_TEST_STREAM_ID not set");
		LiveTest.SkipIf(endpoint == null || token == null || repoId == null, "CHECKPOINT_TEST_ENDPOINT/CHECKPOINT_TEST_TOKEN/CHECKPOINT_TEST_REPO_ID not set");

		return new Env
		{
			Horde = new HttpClient { BaseAddress = new Uri(hordeEndpoint!), Timeout = TimeSpan.FromSeconds(60) },
			StreamId = streamId!,
			Checkpoint = new CheckpointClient(new HttpClient(), new CheckpointClientOptions { Endpoint = new Uri(endpoint!), Token = token! }),
			RepoId = repoId!,
			Branch = LiveTest.Env("CHECKPOINT_TEST_BRANCH") ?? "main",
		};
	}

	static async Task<JsonElement> GetJsonAsync(HttpClient client, string path)
	{
		using HttpResponseMessage response = await client.GetAsync(path);
		string body = await response.Content.ReadAsStringAsync();
		Assert.True(response.StatusCode == HttpStatusCode.OK, $"GET {path} returned {(int)response.StatusCode}: {body}");
		using JsonDocument document = JsonDocument.Parse(body);
		return document.RootElement.Clone();
	}

	static string? GetString(JsonElement element, string name)
		=> element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

	static List<string> GetStrings(JsonElement element, string name)
	{
		if (!element.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.Array)
		{
			return new List<string>();
		}
		return value.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? x.GetString()! : x.GetRawText()).ToList();
	}

	static HordeChange ParseChange(JsonElement element)
	{
		string? authorName = null;
		if (element.TryGetProperty("authorInfo", out JsonElement authorInfo) && authorInfo.ValueKind == JsonValueKind.Object)
		{
			authorName = GetString(authorInfo, "name");
		}
		return new HordeChange(
			element.GetProperty("number").GetInt32(),
			GetString(element, "description") ?? String.Empty,
			authorName ?? GetString(element, "author"),
			GetStrings(element, "tags"),
			GetStrings(element, "files"));
	}

	static async Task<List<HordeChange>> GetHordeChangesAsync(Env env, int results)
	{
		JsonElement list = await GetJsonAsync(env.Horde, $"/api/v1/streams/{env.StreamId}/changes?results={results}");
		return list.EnumerateArray().Select(ParseChange).ToList();
	}

	static async Task<HordeChange> GetHordeChangeAsync(Env env, int number)
		=> ParseChange(await GetJsonAsync(env.Horde, $"/api/v1/streams/{env.StreamId}/changes/{number}"));

	static async Task<ChangelistInfo> FindChangelistAsync(Env env, string message)
	{
		List<ChangelistInfo> changelists = await env.Checkpoint.GetChangelistsAsync(env.RepoId, env.Branch, null, 50);
		ChangelistInfo? match = changelists.FirstOrDefault(x => x.Message == message);
		Assert.True(match != null, $"No changelist with message '{message}' on {env.Branch}; the seed step (scripts/ci/seed-horde-repo.mjs) should have created it");
		return match!;
	}

	[SkippableFact]
	public async Task StreamIsLoaded()
	{
		Env env = Require();

		// The stream only exists if Horde loaded the config, which names "vcs": "Checkpoint".
		JsonElement stream = await GetJsonAsync(env.Horde, $"/api/v1/streams/{env.StreamId}");
		Assert.Equal(env.StreamId, GetString(stream, "id"));
	}

	[SkippableFact]
	public async Task ChangesMatchCheckpointHistory()
	{
		Env env = Require();

		List<ChangelistInfo> expected = await env.Checkpoint.GetChangelistsAsync(env.RepoId, env.Branch, null, 50);
		Assert.True(expected.Count >= 4, $"expected the seeded history (initial changelist + 3 submits), got {expected.Count} changelists");

		List<HordeChange> actual = await GetHordeChangesAsync(env, 50);

		Assert.Equal(expected.Select(x => x.Number), actual.Select(x => x.Number));
		Assert.Equal(expected.Select(x => x.Message), actual.Select(x => x.Description));
	}

	[SkippableFact]
	public async Task ChangesRespectMinMaxAndResults()
	{
		Env env = Require();

		List<ChangelistInfo> history = await env.Checkpoint.GetChangelistsAsync(env.RepoId, env.Branch, null, 50);
		int head = history[0].Number;
		int middle = history[history.Count / 2].Number;

		List<HordeChange> limited = await GetHordeChangesAsync(env, 2);
		Assert.Equal(history.Take(2).Select(x => x.Number), limited.Select(x => x.Number));

		JsonElement ranged = await GetJsonAsync(env.Horde, $"/api/v1/streams/{env.StreamId}/changes?min={middle}&max={head}&results=50");
		List<int> rangedNumbers = ranged.EnumerateArray().Select(x => x.GetProperty("number").GetInt32()).ToList();
		Assert.Equal(history.Where(x => x.Number >= middle && x.Number <= head).Select(x => x.Number), rangedNumbers);
	}

	[SkippableFact]
	public async Task ChangeDetailsMatchCheckpoint()
	{
		Env env = Require();

		ChangelistInfo changelist = await FindChangelistAsync(env, "Horde CI: code and content together");
		HordeChange change = await GetHordeChangeAsync(env, changelist.Number);

		Assert.Equal(changelist.Number, change.Number);
		Assert.Equal(changelist.Message, change.Description);
		Assert.False(String.IsNullOrEmpty(change.AuthorName), "Horde should map the Checkpoint author to a Horde user");

		List<ChangelistFileInfo> expectedFiles = await env.Checkpoint.GetChangelistFilesAsync(env.RepoId, changelist.Number);
		IEnumerable<string> expectedPaths = expectedFiles.Select(x => x.Path.TrimStart('/')).Order(StringComparer.Ordinal);
		IEnumerable<string> actualPaths = change.Files.Select(x => x.TrimStart('/')).Order(StringComparer.Ordinal);
		Assert.Equal(expectedPaths, actualPaths);
	}

	[SkippableFact]
	public async Task MissingChangeIsNotFound()
	{
		Env env = Require();

		using HttpResponseMessage response = await env.Horde.GetAsync($"/api/v1/streams/{env.StreamId}/changes/999999");
		Assert.False(response.IsSuccessStatusCode, $"changelist 999999 should not resolve, got {(int)response.StatusCode}");
	}

	[SkippableFact]
	public async Task CommitTagsFollowChangedFiles()
	{
		Env env = Require();

		// Horde's default "code" and "content" tag filters, evaluated against Checkpoint's file lists.
		HordeChange code = await GetHordeChangeAsync(env, (await FindChangelistAsync(env, "Horde CI: add game source")).Number);
		Assert.Contains("code", code.Tags, StringComparer.OrdinalIgnoreCase);
		Assert.DoesNotContain("content", code.Tags, StringComparer.OrdinalIgnoreCase);

		HordeChange content = await GetHordeChangeAsync(env, (await FindChangelistAsync(env, "Horde CI: add a map")).Number);
		Assert.Contains("content", content.Tags, StringComparer.OrdinalIgnoreCase);
		Assert.DoesNotContain("code", content.Tags, StringComparer.OrdinalIgnoreCase);
	}
}
