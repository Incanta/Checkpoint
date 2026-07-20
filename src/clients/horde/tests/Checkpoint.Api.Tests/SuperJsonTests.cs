using System.Text.Json.Nodes;
using Xunit;

namespace Checkpoint.Api.Tests;

public class SuperJsonTests
{
	[Fact]
	public void BuildEnvelope_NoInput_ProducesJsonNull()
	{
		JsonObject envelope = SuperJson.BuildEnvelope(null);
		Assert.Equal("{\"json\":null}", envelope.ToJsonString());
	}

	[Fact]
	public void BuildEnvelope_PlainInput_HasNoMeta()
	{
		JsonObject envelope = SuperJson.BuildEnvelope(new JsonObject { ["repoId"] = "abc" });
		Assert.Equal("{\"json\":{\"repoId\":\"abc\"}}", envelope.ToJsonString());
	}

	[Fact]
	public void BuildEnvelope_DateFields_ProduceMetaValues()
	{
		JsonObject input = new JsonObject
		{
			["start"] = new JsonObject { ["timestamp"] = "2026-07-19T00:00:00.000Z" },
		};
		JsonObject envelope = SuperJson.BuildEnvelope(input, new[] { "start.timestamp" });
		Assert.Equal(
			"{\"json\":{\"start\":{\"timestamp\":\"2026-07-19T00:00:00.000Z\"}},\"meta\":{\"values\":{\"start.timestamp\":[\"Date\"]}}}",
			envelope.ToJsonString());
	}

	[Fact]
	public void UnwrapResponse_SuccessEnvelope_ReturnsJsonPayload()
	{
		JsonNode? result = SuperJson.UnwrapResponse("[{\"result\":{\"data\":{\"json\":{\"a\":1},\"meta\":{\"values\":{}}}}}]", 200, "test.proc");
		Assert.NotNull(result);
		Assert.Equal(1, (int)result!["a"]!);
	}

	[Fact]
	public void UnwrapResponse_NullPayload_ReturnsNull()
	{
		JsonNode? result = SuperJson.UnwrapResponse("[{\"result\":{\"data\":{\"json\":null}}}]", 200, "test.proc");
		Assert.Null(result);
	}

	[Fact]
	public void UnwrapResponse_ErrorEnvelope_ThrowsWithCodeAndStatus()
	{
		TrpcException ex = Assert.Throws<TrpcException>(() =>
			SuperJson.UnwrapResponse(FakeHttpHandler.Error("Could not find branch", "NOT_FOUND", 404), 404, "branch.getBranch"));
		Assert.Contains("Could not find branch", ex.Message);
		Assert.Equal("NOT_FOUND", ex.TrpcCode);
		Assert.Equal(404, ex.HttpStatus);
		Assert.True(ex.IsNotFound);
	}

	[Fact]
	public void UnwrapResponse_EmptyBodyWithErrorStatus_Throws()
	{
		TrpcException ex = Assert.Throws<TrpcException>(() => SuperJson.UnwrapResponse("", 500, "test.proc"));
		Assert.Equal(500, ex.HttpStatus);
	}

	[Fact]
	public void UnwrapResponse_EmptyBodyWithSuccessStatus_ReturnsNull()
	{
		Assert.Null(SuperJson.UnwrapResponse("", 200, "test.proc"));
	}

	[Fact]
	public void UnwrapResponse_NonJsonBody_ThrowsWithPreview()
	{
		TrpcException ex = Assert.Throws<TrpcException>(() => SuperJson.UnwrapResponse("<html>bad gateway</html>", 502, "test.proc"));
		Assert.Contains("Invalid JSON", ex.Message);
		Assert.Contains("bad gateway", ex.Message);
	}
}
