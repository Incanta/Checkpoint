using System.Text.Json;
using System.Text.Json.Nodes;

namespace Checkpoint.Api;

/// <summary>
/// Helpers for the superjson envelope format used by the Checkpoint tRPC API.
///
/// Requests wrap their input as {"json": &lt;input&gt;, "meta": {"values": {"path.to.field": ["Date"]}}},
/// where meta is only needed for values whose JSON representation loses type information (Date, bigint).
/// Responses arrive as {"json": &lt;data&gt;, "meta": ...}; Date fields are ISO-8601 strings in the json
/// payload (directly deserializable), and bigint fields are strings, so consumers only need meta when a
/// field's static type doesn't already say how to parse it.
/// </summary>
public static class SuperJson
{
	/// <summary>
	/// Builds the superjson envelope for a request input. <paramref name="dateFields"/> lists dotted paths
	/// (array indices as path segments, e.g. "start.timestamp" or "items.0.createdAt") of fields that the
	/// server declares as z.date() and which are serialized as ISO-8601 strings in <paramref name="input"/>.
	/// </summary>
	public static JsonObject BuildEnvelope(JsonNode? input, IReadOnlyCollection<string>? dateFields = null)
	{
		JsonObject envelope = new JsonObject { ["json"] = input };
		if (dateFields != null && dateFields.Count > 0)
		{
			JsonObject values = new JsonObject();
			foreach (string path in dateFields)
			{
				values[path] = new JsonArray("Date");
			}
			envelope["meta"] = new JsonObject { ["values"] = values };
		}
		return envelope;
	}

	/// <summary>
	/// Unwraps a tRPC httpBatchLink response body (batch of one) down to the inner json payload.
	/// Throws <see cref="TrpcException"/> for tRPC error envelopes or unparseable bodies.
	/// </summary>
	public static JsonNode? UnwrapResponse(string body, int httpStatus, string procedure)
	{
		if (String.IsNullOrEmpty(body))
		{
			if (httpStatus is >= 200 and < 300)
			{
				return null;
			}
			throw new TrpcException($"Checkpoint server returned HTTP {httpStatus} with an empty body", httpStatus: httpStatus, procedure: procedure);
		}

		JsonNode? parsed;
		try
		{
			parsed = JsonNode.Parse(body);
		}
		catch (JsonException ex)
		{
			string preview = body.Length > 200 ? body[..200] : body;
			throw new TrpcException($"Invalid JSON response from Checkpoint server (HTTP {httpStatus}, {body.Length} bytes): {ex.Message}. Response preview: {preview}", httpStatus: httpStatus, procedure: procedure, innerException: ex);
		}

		// httpBatchLink wraps responses in an array: [{result: ...}] or [{error: ...}]
		if (parsed is JsonArray array)
		{
			if (array.Count == 0)
			{
				return null;
			}
			parsed = array[0];
		}

		if (parsed is JsonObject obj)
		{
			if (obj.TryGetPropertyValue("error", out JsonNode? error))
			{
				throw CreateErrorException(error, httpStatus, procedure);
			}
			if (obj.TryGetPropertyValue("result", out JsonNode? result))
			{
				if (result is JsonObject resultObj && resultObj.TryGetPropertyValue("data", out JsonNode? data))
				{
					if (data is JsonObject dataObj && dataObj.TryGetPropertyValue("json", out JsonNode? json))
					{
						return json;
					}
					return data;
				}
				return result;
			}
		}

		return parsed;
	}

	static TrpcException CreateErrorException(JsonNode? error, int httpStatus, string procedure)
	{
		string message = "Checkpoint server error";
		string? code = null;
		int? status = httpStatus >= 400 ? httpStatus : null;

		JsonNode? errorJson = (error as JsonObject)?["json"] ?? error;
		if (errorJson is JsonObject errorObj)
		{
			if (errorObj["message"] is JsonValue messageValue && messageValue.TryGetValue(out string? messageStr))
			{
				message = messageStr;
			}
			if (errorObj["data"] is JsonObject dataObj)
			{
				if (dataObj["code"] is JsonValue codeValue && codeValue.TryGetValue(out string? codeStr))
				{
					code = codeStr;
				}
				if (dataObj["httpStatus"] is JsonValue statusValue && statusValue.TryGetValue(out int statusInt))
				{
					status = statusInt;
				}
			}
		}

		return new TrpcException($"{message} (procedure: {procedure})", code, status, procedure);
	}
}
