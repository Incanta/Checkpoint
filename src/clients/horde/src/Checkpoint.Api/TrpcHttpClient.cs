using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace Checkpoint.Api;

/// <summary>
/// Low-level client for the Checkpoint server's tRPC-over-HTTP API (httpBatchLink + superjson).
///
/// Wire format (mirrors src/clients/cli/daemon_client.hpp):
///   Query:    GET  {base}/{procedure}?batch=1&amp;input=urlencode({"0":{"json":&lt;input&gt;}})
///   Mutation: POST {base}/{procedure}?batch=1 with body {"0":{"json":&lt;input&gt;}}
/// Responses: [{"result":{"data":{"json":&lt;data&gt;,"meta":...}}}] or [{"error":{"json":{...}}}]
/// </summary>
public class TrpcHttpClient
{
	readonly HttpClient _httpClient;
	readonly CheckpointClientOptions _options;
	readonly Uri _baseUri;

	public TrpcHttpClient(HttpClient httpClient, CheckpointClientOptions options)
	{
		_httpClient = httpClient;
		_options = options;

		Uri endpoint = options.ResolveEndpoint();
		string basePath = options.BasePath.Trim('/');
		string prefix = endpoint.AbsoluteUri.TrimEnd('/');
		_baseUri = new Uri(basePath.Length > 0 ? $"{prefix}/{basePath}/" : $"{prefix}/", UriKind.Absolute);
	}

	/// <summary>
	/// The resolved endpoint this client talks to, for diagnostics.
	/// </summary>
	public Uri BaseUri => _baseUri;

	/// <summary>
	/// Executes a tRPC query (HTTP GET).
	/// </summary>
	public async Task<JsonNode?> QueryAsync(string procedure, JsonNode? input = null, IReadOnlyCollection<string>? dateFields = null, CancellationToken cancellationToken = default)
	{
		JsonObject batch = new JsonObject { ["0"] = SuperJson.BuildEnvelope(input, dateFields) };
		string url = $"{_baseUri}{procedure}?batch=1&input={Uri.EscapeDataString(batch.ToJsonString())}";

		using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Get, url);
		return await SendAsync(request, procedure, cancellationToken);
	}

	/// <summary>
	/// Executes a tRPC mutation (HTTP POST).
	/// </summary>
	public async Task<JsonNode?> MutateAsync(string procedure, JsonNode? input, IReadOnlyCollection<string>? dateFields = null, CancellationToken cancellationToken = default)
	{
		JsonObject batch = new JsonObject { ["0"] = SuperJson.BuildEnvelope(input, dateFields) };
		string url = $"{_baseUri}{procedure}?batch=1";

		using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, url);
		request.Content = new StringContent(batch.ToJsonString(), Encoding.UTF8, "application/json");
		return await SendAsync(request, procedure, cancellationToken);
	}

	async Task<JsonNode?> SendAsync(HttpRequestMessage request, string procedure, CancellationToken cancellationToken)
	{
		string? token = _options.ResolveToken();
		if (token != null)
		{
			request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
		}

		using CancellationTokenSource timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeoutCts.CancelAfter(_options.Timeout);

		HttpResponseMessage response;
		string body;
		try
		{
			response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeoutCts.Token);
			using (response)
			{
				body = await response.Content.ReadAsStringAsync(timeoutCts.Token);
			}
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			throw new TrpcException($"Request to Checkpoint server timed out after {_options.Timeout.TotalSeconds:0}s", procedure: procedure);
		}
		catch (HttpRequestException ex)
		{
			throw new TrpcException($"Failed to reach Checkpoint server at {_baseUri}: {ex.Message}", procedure: procedure, innerException: ex);
		}

		return SuperJson.UnwrapResponse(body, (int)response.StatusCode, procedure);
	}
}
