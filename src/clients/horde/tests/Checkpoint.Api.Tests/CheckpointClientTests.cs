using System.Net;
using System.Text.Json.Nodes;
using System.Web;
using Checkpoint.Api.Models;
using Xunit;

namespace Checkpoint.Api.Tests;

public class CheckpointClientTests
{
	static CheckpointClient CreateClient(FakeHttpHandler handler, string? token = "test-token")
	{
		CheckpointClientOptions options = new CheckpointClientOptions
		{
			Endpoint = new Uri("https://checkpoint.example.com"),
			Token = token,
		};
		return new CheckpointClient(new HttpClient(handler), options);
	}

	static JsonNode ParseQueryInput(HttpRequestMessage request)
	{
		string? input = HttpUtility.ParseQueryString(request.RequestUri!.Query)["input"];
		Assert.NotNull(input);
		return JsonNode.Parse(input!)!["0"]!["json"]!;
	}

	[Fact]
	public async Task Query_BuildsExpectedUrlAndAuthHeader()
	{
		FakeHttpHandler handler = new FakeHttpHandler((request, _) =>
			(HttpStatusCode.OK, FakeHttpHandler.Success("{\"serverVersion\":\"0.4.15\",\"serverApi\":2,\"minServerApi\":2}")));
		CheckpointClient client = CreateClient(handler);

		ServerVersionInfo version = await client.GetServerVersionAsync();

		Assert.Equal("0.4.15", version.ServerVersion);
		Assert.Equal(2, version.ServerApi);

		(HttpRequestMessage request, _) = Assert.Single(handler.Requests);
		Assert.Equal(HttpMethod.Get, request.Method);
		Assert.StartsWith("https://checkpoint.example.com/api/trpc/version.current?batch=1&input=", request.RequestUri!.AbsoluteUri);
		Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
		Assert.Equal("test-token", request.Headers.Authorization.Parameter);

		string? input = HttpUtility.ParseQueryString(request.RequestUri.Query)["input"];
		Assert.Equal("{\"0\":{\"json\":null}}", input);
	}

	[Fact]
	public async Task GetChangelists_SendsRequiredNullableStartFields()
	{
		FakeHttpHandler handler = new FakeHttpHandler((_, _) => (HttpStatusCode.OK, FakeHttpHandler.Success("[]")));
		CheckpointClient client = CreateClient(handler);

		await client.GetChangelistsAsync("repo1", "main", null, 50);

		JsonNode input = ParseQueryInput(handler.Requests[0].Request);
		Assert.Equal("repo1", (string)input["repoId"]!);
		Assert.Equal("main", (string)input["branchName"]!);
		Assert.Equal(50, (int)input["count"]!);
		// zod declares start.number/start.timestamp as nullable but NOT optional: they must be present
		JsonObject start = Assert.IsType<JsonObject>(input["start"]);
		Assert.True(start.ContainsKey("number"));
		Assert.Null(start["number"]);
		Assert.True(start.ContainsKey("timestamp"));
		Assert.Null(start["timestamp"]);
	}

	[Fact]
	public async Task Mutation_PostsBatchBody()
	{
		FakeHttpHandler handler = new FakeHttpHandler((_, _) => (HttpStatusCode.OK, FakeHttpHandler.Success("[]")));
		CheckpointClient client = CreateClient(handler);

		await client.GetChangelistsWithNumbersAsync("repo1", new[] { 3, 5 });

		(HttpRequestMessage request, string? body) = Assert.Single(handler.Requests);
		Assert.Equal(HttpMethod.Post, request.Method);
		Assert.EndsWith("/api/trpc/changelist.getChangelistsWithNumbers?batch=1", request.RequestUri!.AbsoluteUri);
		Assert.Equal("{\"0\":{\"json\":{\"repoId\":\"repo1\",\"numbers\":[3,5]}}}", body);
	}

	[Fact]
	public async Task Changelist_DeserializesDatesAuthorsAndNullables()
	{
		string payload = """
			{
				"id":"cl_1","createdAt":"2026-07-19T01:02:03.000Z","updatedAt":"2026-07-19T01:02:04.000Z",
				"number":42,"message":"Fix things","versionIndex":"vi",
				"stateRootHash":null,"artifactVersionIndex":null,"artifactStateTree":null,
				"repoId":"repo1","userId":"user1","parentNumber":41,
				"user":{"id":"user1","email":"dev@example.com","name":"Dev","username":null}
			}
			""";
		FakeHttpHandler handler = new FakeHttpHandler((_, _) => (HttpStatusCode.OK, FakeHttpHandler.Success(payload)));
		CheckpointClient client = CreateClient(handler);

		ChangelistInfo? changelist = await client.GetChangelistAsync("repo1", 42);

		Assert.NotNull(changelist);
		Assert.Equal(42, changelist!.Number);
		Assert.Equal(41, changelist.ParentNumber);
		Assert.Equal(new DateTime(2026, 7, 19, 1, 2, 3, DateTimeKind.Utc), changelist.CreatedAt.ToUniversalTime());
		Assert.Equal("dev@example.com", changelist.User!.Email);
		Assert.Null(changelist.User.Username);
	}

	[Fact]
	public async Task GetChangelist_MissingReturnsNull()
	{
		FakeHttpHandler handler = new FakeHttpHandler((_, _) => (HttpStatusCode.OK, FakeHttpHandler.Success("null")));
		CheckpointClient client = CreateClient(handler);
		Assert.Null(await client.GetChangelistAsync("repo1", 999));
	}

	[Fact]
	public async Task Repo_DeserializesBigIntStorageBytesFromString()
	{
		string payload = "[{\"id\":\"repo1\",\"name\":\"game\",\"orgId\":\"org1\",\"public\":false,\"storageBytes\":\"123456789012345\"}]";
		FakeHttpHandler handler = new FakeHttpHandler((_, _) => (HttpStatusCode.OK, FakeHttpHandler.Success(payload)));
		CheckpointClient client = CreateClient(handler);

		List<RepoInfo> repos = await client.ListReposAsync("org1");

		Assert.Equal(123456789012345L, Assert.Single(repos).StorageBytes);
	}

	[Fact]
	public async Task ChangelistFiles_DeserializesEnumsAndRenames()
	{
		string payload = "[{\"id\":\"fc1\",\"fileId\":\"f1\",\"path\":\"Content/A.uasset\",\"changeType\":\"MODIFY\",\"oldPath\":null}," +
			"{\"id\":\"fc2\",\"fileId\":\"f2\",\"path\":\"Source/New.cpp\",\"changeType\":\"ADD\",\"oldPath\":\"Source/Old.cpp\"}]";
		FakeHttpHandler handler = new FakeHttpHandler((_, _) => (HttpStatusCode.OK, FakeHttpHandler.Success(payload)));
		CheckpointClient client = CreateClient(handler);

		List<ChangelistFileInfo> files = await client.GetChangelistFilesAsync("repo1", 42);

		Assert.Equal(FileChangeKind.MODIFY, files[0].ChangeType);
		Assert.Equal(FileChangeKind.ADD, files[1].ChangeType);
		Assert.Equal("Source/Old.cpp", files[1].OldPath);
	}

	[Fact]
	public async Task ErrorEnvelope_SurfacesAsTrpcException()
	{
		FakeHttpHandler handler = new FakeHttpHandler((_, _) =>
			(HttpStatusCode.Unauthorized, FakeHttpHandler.Error("Invalid token", "UNAUTHORIZED", 401)));
		CheckpointClient client = CreateClient(handler);

		TrpcException ex = await Assert.ThrowsAsync<TrpcException>(() => client.GetMeAsync());
		Assert.True(ex.IsAuthError);
		Assert.Equal("UNAUTHORIZED", ex.TrpcCode);
	}

	// ---- Tailing ----

	static FakeHttpHandler CreateChainHandler(int headNumber, int chainBottom = 1)
	{
		// Synthetic linear history: CL n has parent n-1 down to chainBottom
		return new FakeHttpHandler((request, _) =>
		{
			JsonNode input = JsonNode.Parse(HttpUtility.ParseQueryString(request.RequestUri!.Query)["input"]!)!["0"]!["json"]!;
			int count = (int)input["count"]!;
			int start = input["start"]!["number"] == null ? headNumber : (int)input["start"]!["number"]!;

			List<string> items = new List<string>();
			for (int n = start; n > start - count && n >= chainBottom; n--)
			{
				string parent = n > chainBottom ? (n - 1).ToString() : "null";
				items.Add($"{{\"id\":\"cl_{n}\",\"createdAt\":\"2026-07-19T00:00:00.000Z\",\"number\":{n},\"message\":\"m{n}\",\"versionIndex\":\"vi\",\"repoId\":\"repo1\",\"userId\":null,\"parentNumber\":{parent},\"user\":null}}");
			}
			return (HttpStatusCode.OK, FakeHttpHandler.Success("[" + String.Join(",", items) + "]"));
		});
	}

	[Fact]
	public async Task GetChangelistsSince_SinglePage_ReturnsAscendingWithoutSince()
	{
		CheckpointClient client = CreateClient(CreateChainHandler(headNumber: 20));

		List<ChangelistInfo> result = await client.GetChangelistsSinceAsync("repo1", "main", sinceNumber: 15);

		Assert.Equal(new[] { 16, 17, 18, 19, 20 }, result.Select(x => x.Number));
	}

	[Fact]
	public async Task GetChangelistsSince_MultiPage_PagesWithoutDuplicates()
	{
		CheckpointClient client = CreateClient(CreateChainHandler(headNumber: 250));

		List<ChangelistInfo> result = await client.GetChangelistsSinceAsync("repo1", "main", sinceNumber: 30);

		Assert.Equal(220, result.Count);
		Assert.Equal(31, result[0].Number);
		Assert.Equal(250, result[^1].Number);
		Assert.Equal(result.Count, result.Select(x => x.Number).Distinct().Count());
	}

	[Fact]
	public async Task GetChangelistsSince_ChainEnd_StopsCleanly()
	{
		CheckpointClient client = CreateClient(CreateChainHandler(headNumber: 5, chainBottom: 1));

		List<ChangelistInfo> result = await client.GetChangelistsSinceAsync("repo1", "main", sinceNumber: 0);

		Assert.Equal(new[] { 1, 2, 3, 4, 5 }, result.Select(x => x.Number));
	}

	[Fact]
	public async Task GetChangelistsSince_UpToDate_ReturnsEmpty()
	{
		CheckpointClient client = CreateClient(CreateChainHandler(headNumber: 20));

		List<ChangelistInfo> result = await client.GetChangelistsSinceAsync("repo1", "main", sinceNumber: 20);

		Assert.Empty(result);
	}
}
