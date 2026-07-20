using System.Net;
using System.Text;

namespace Checkpoint.Api.Tests;

/// <summary>
/// HttpMessageHandler that routes requests to a test-supplied delegate and records them.
/// </summary>
public sealed class FakeHttpHandler : HttpMessageHandler
{
	readonly Func<HttpRequestMessage, string?, (HttpStatusCode, string)> _respond;

	public List<(HttpRequestMessage Request, string? Body)> Requests { get; } = new();

	public FakeHttpHandler(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> respond)
	{
		_respond = respond;
	}

	protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
	{
		string? body = request.Content == null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
		Requests.Add((request, body));

		(HttpStatusCode status, string responseBody) = _respond(request, body);
		return new HttpResponseMessage(status)
		{
			Content = new StringContent(responseBody, Encoding.UTF8, "application/json"),
			RequestMessage = request,
		};
	}

	/// <summary>
	/// Wraps a payload in the tRPC batch success envelope.
	/// </summary>
	public static string Success(string jsonPayload)
	{
		return $"[{{\"result\":{{\"data\":{{\"json\":{jsonPayload}}}}}}}]";
	}

	/// <summary>
	/// Builds a tRPC batch error envelope.
	/// </summary>
	public static string Error(string message, string code, int httpStatus)
	{
		return $"[{{\"error\":{{\"json\":{{\"message\":\"{message}\",\"code\":-32600,\"data\":{{\"code\":\"{code}\",\"httpStatus\":{httpStatus}}}}}}}}}]";
	}
}
