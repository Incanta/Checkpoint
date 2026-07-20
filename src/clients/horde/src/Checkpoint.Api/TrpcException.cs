namespace Checkpoint.Api;

/// <summary>
/// Error returned by the Checkpoint server's tRPC API, or a transport/protocol failure while calling it.
/// </summary>
public sealed class TrpcException : Exception
{
	/// <summary>
	/// tRPC error code string (e.g. "NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"), if the server provided one.
	/// </summary>
	public string? TrpcCode { get; }

	/// <summary>
	/// HTTP status code associated with the error, if known.
	/// </summary>
	public int? HttpStatus { get; }

	/// <summary>
	/// The procedure that was being invoked (e.g. "changelist.getChangelists").
	/// </summary>
	public string? Procedure { get; }

	public TrpcException(string message, string? trpcCode = null, int? httpStatus = null, string? procedure = null, Exception? innerException = null)
		: base(message, innerException)
	{
		TrpcCode = trpcCode;
		HttpStatus = httpStatus;
		Procedure = procedure;
	}

	/// <summary>
	/// True when the failure indicates bad credentials or missing access rather than a transient fault.
	/// </summary>
	public bool IsAuthError => TrpcCode is "UNAUTHORIZED" or "FORBIDDEN" || HttpStatus is 401 or 403;

	/// <summary>
	/// True when the server reported that the requested entity does not exist.
	/// </summary>
	public bool IsNotFound => TrpcCode is "NOT_FOUND" || HttpStatus is 404;
}
