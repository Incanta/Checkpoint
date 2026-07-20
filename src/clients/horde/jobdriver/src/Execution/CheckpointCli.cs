// Copyright Incanta Games. All Rights Reserved.

using System.Diagnostics;
using System.Text;
using EpicGames.Core;
using Microsoft.Extensions.Logging;

namespace JobDriver.Execution;

/// <summary>
/// Runs the Checkpoint CLI as a child process, in headless (ephemeral daemon) mode.
/// </summary>
sealed class CheckpointCli
{
	readonly string _cliPath;
	readonly IReadOnlyDictionary<string, string> _environment;
	readonly IReadOnlyList<string> _secrets;
	readonly ILogger _logger;

	public CheckpointCli(string cliPath, IReadOnlyDictionary<string, string> environment, IReadOnlyList<string> secrets, ILogger logger)
	{
		_cliPath = cliPath;
		_environment = environment;
		_secrets = secrets;
		_logger = logger;
	}

	/// <summary>
	/// Locates the Checkpoint CLI executable. Priority: explicit override (Method cli= parameter),
	/// CHECKPOINT_CLI environment variable, a copy bundled in the driver's tools folder, then PATH.
	/// </summary>
	public static string ResolveCliPath(string? overridePath)
	{
		if (!String.IsNullOrEmpty(overridePath))
		{
			return overridePath;
		}

		string? fromEnv = Environment.GetEnvironmentVariable("CHECKPOINT_CLI");
		if (!String.IsNullOrEmpty(fromEnv))
		{
			return fromEnv;
		}

		string exeName = OperatingSystem.IsWindows() ? "checkpoint.exe" : "checkpoint";
		string bundled = Path.Combine(AppContext.BaseDirectory, "tools", exeName);
		if (File.Exists(bundled))
		{
			return bundled;
		}

		return "checkpoint";
	}

	/// <summary>
	/// Directory containing a bundled Checkpoint daemon build, if the driver ships one.
	/// </summary>
	public static string? ResolveBundledDaemonDir()
	{
		string dir = Path.Combine(AppContext.BaseDirectory, "tools");
		return Directory.Exists(dir) && Directory.EnumerateFiles(dir, "*daemon*").Any() ? dir : null;
	}

	/// <summary>
	/// Runs the CLI with the given arguments, streaming output to the logger. Throws
	/// <see cref="WorkspaceMaterializationException"/> on a non-zero exit code.
	/// </summary>
	public async Task RunAsync(DirectoryReference workingDir, IReadOnlyList<string> arguments, CancellationToken cancellationToken)
	{
		using Process process = new Process();
		process.StartInfo.FileName = _cliPath;
		foreach (string argument in arguments)
		{
			process.StartInfo.ArgumentList.Add(argument);
		}
		process.StartInfo.WorkingDirectory = workingDir.FullName;
		process.StartInfo.UseShellExecute = false;
		process.StartInfo.RedirectStandardOutput = true;
		process.StartInfo.RedirectStandardError = true;
		process.StartInfo.StandardOutputEncoding = Encoding.UTF8;
		process.StartInfo.StandardErrorEncoding = Encoding.UTF8;

		foreach ((string key, string value) in _environment)
		{
			process.StartInfo.Environment[key] = value;
		}

		string displayArgs = String.Join(' ', arguments.Select(RedactArgument));
		_logger.LogInformation("Running: checkpoint {Arguments} (in {WorkingDir})", displayArgs, workingDir);

		StringBuilder recentOutput = new StringBuilder();

		process.OutputDataReceived += (_, args) =>
		{
			if (args.Data != null)
			{
				_logger.LogInformation("checkpoint: {Line}", args.Data);
				AppendRecent(recentOutput, args.Data);
			}
		};
		process.ErrorDataReceived += (_, args) =>
		{
			if (args.Data != null)
			{
				_logger.LogWarning("checkpoint: {Line}", args.Data);
				AppendRecent(recentOutput, args.Data);
			}
		};

		try
		{
			if (!process.Start())
			{
				throw new WorkspaceMaterializationException($"Failed to start Checkpoint CLI at '{_cliPath}'");
			}
		}
		catch (Exception ex) when (ex is not WorkspaceMaterializationException)
		{
			throw new WorkspaceMaterializationException($"Failed to start Checkpoint CLI at '{_cliPath}': {ex.Message}. Install the Checkpoint CLI on this agent or bundle it in the driver's tools folder.", ex);
		}

		process.BeginOutputReadLine();
		process.BeginErrorReadLine();

		try
		{
			await process.WaitForExitAsync(cancellationToken);
		}
		catch (OperationCanceledException)
		{
			try
			{
				process.Kill(entireProcessTree: true);
			}
			catch
			{
				// Best effort; the process may have exited already
			}
			throw;
		}

		if (process.ExitCode != 0)
		{
			throw new WorkspaceMaterializationException($"Checkpoint CLI failed (exit code {process.ExitCode}): checkpoint {displayArgs}\n{recentOutput}");
		}
	}

	static void AppendRecent(StringBuilder builder, string line)
	{
		const int MaxLength = 4096;
		builder.AppendLine(line);
		if (builder.Length > MaxLength)
		{
			builder.Remove(0, builder.Length - MaxLength);
		}
	}

	string RedactArgument(string argument)
		=> _secrets.Any(secret => secret.Length > 0 && argument.Contains(secret, StringComparison.Ordinal)) ? "[redacted]" : argument;
}
