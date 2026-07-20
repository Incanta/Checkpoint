namespace Checkpoint.Api;

/// <summary>
/// Connection settings for a Checkpoint server.
/// </summary>
public sealed class CheckpointClientOptions
{
	/// <summary>
	/// Environment variable holding the API endpoint, honored across all Checkpoint clients.
	/// </summary>
	public const string EndpointEnvVarName = "CHECKPOINT_ENDPOINT";

	/// <summary>
	/// Environment variable holding the API token, honored across all Checkpoint clients.
	/// </summary>
	public const string TokenEnvVarName = "CHECKPOINT_API_TOKEN";

	/// <summary>
	/// Base URL of the Checkpoint server (e.g. https://checkpoint.example.com). Falls back to the
	/// CHECKPOINT_ENDPOINT environment variable when unset.
	/// </summary>
	public Uri? Endpoint { get; set; }

	/// <summary>
	/// API token (ApiToken.token) sent as a bearer token. Falls back to the environment variable
	/// named by <see cref="TokenEnvVar"/> when unset.
	/// </summary>
	public string? Token { get; set; }

	/// <summary>
	/// Name of the environment variable to read the token from when <see cref="Token"/> is unset.
	/// </summary>
	public string TokenEnvVar { get; set; } = TokenEnvVarName;

	/// <summary>
	/// Path under the endpoint where the tRPC API lives. The app server uses "/api/trpc"; the local
	/// daemon serves procedures at its root ("").
	/// </summary>
	public string BasePath { get; set; } = "/api/trpc";

	/// <summary>
	/// Per-request timeout.
	/// </summary>
	public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(100);

	/// <summary>
	/// Resolves the effective endpoint, throwing when neither the option nor the environment provides one.
	/// </summary>
	public Uri ResolveEndpoint()
	{
		if (Endpoint != null)
		{
			return Endpoint;
		}
		string? fromEnv = Environment.GetEnvironmentVariable(EndpointEnvVarName);
		if (!String.IsNullOrEmpty(fromEnv) && Uri.TryCreate(fromEnv, UriKind.Absolute, out Uri? uri))
		{
			return uri;
		}
		throw new TrpcException($"No Checkpoint endpoint configured. Set {nameof(CheckpointClientOptions)}.{nameof(Endpoint)} or the {EndpointEnvVarName} environment variable.");
	}

	/// <summary>
	/// Resolves the effective API token, or null for anonymous access (only public procedures will work).
	/// </summary>
	public string? ResolveToken()
	{
		if (!String.IsNullOrEmpty(Token))
		{
			return Token;
		}
		string? fromEnv = Environment.GetEnvironmentVariable(TokenEnvVar);
		return String.IsNullOrEmpty(fromEnv) ? null : fromEnv;
	}
}
