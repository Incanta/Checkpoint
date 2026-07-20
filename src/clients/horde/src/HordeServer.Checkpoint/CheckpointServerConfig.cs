// Copyright Incanta Games. All Rights Reserved.

using HordeServer.Plugins;

namespace HordeServer
{
	/// <summary>
	/// Deployment-static settings for the Checkpoint plugin, bound from the Horde:Plugins:Checkpoint
	/// section of server.json/appsettings. Connection credentials live here (rather than globals.json)
	/// so that the checkpoint:// config source can authenticate before the global config is loaded.
	/// </summary>
	public class CheckpointServerConfig : PluginServerConfig
	{
		/// <summary>
		/// Connection profiles for Checkpoint servers.
		/// </summary>
		public List<CheckpointConnectionConfig> Connections { get; set; } = new List<CheckpointConnectionConfig>();

		/// <summary>
		/// Finds a connection profile by id, falling back to a default profile driven by the
		/// CHECKPOINT_ENDPOINT/CHECKPOINT_API_TOKEN environment variables when none are configured.
		/// </summary>
		public CheckpointConnectionConfig GetConnection(string? id)
		{
			CheckpointConnectionConfig? connection;
			if (String.IsNullOrEmpty(id) || String.Equals(id, CheckpointConnectionConfig.DefaultId, StringComparison.OrdinalIgnoreCase))
			{
				connection = Connections.FirstOrDefault(x => String.Equals(x.Id, CheckpointConnectionConfig.DefaultId, StringComparison.OrdinalIgnoreCase)) ?? Connections.FirstOrDefault();
			}
			else
			{
				connection = Connections.FirstOrDefault(x => String.Equals(x.Id, id, StringComparison.OrdinalIgnoreCase));
				if (connection == null)
				{
					throw new InvalidOperationException($"No Checkpoint connection profile named '{id}' is defined in the Checkpoint plugin server config.");
				}
			}
			return connection ?? new CheckpointConnectionConfig();
		}
	}

	/// <summary>
	/// A named connection to a Checkpoint server.
	/// </summary>
	public class CheckpointConnectionConfig
	{
		/// <summary>
		/// Identifier used to reference this connection from cluster configs and checkpoint:// URIs.
		/// </summary>
		public const string DefaultId = "default";

		/// <summary>
		/// Identifier for this connection profile.
		/// </summary>
		public string Id { get; set; } = DefaultId;

		/// <summary>
		/// Base URL of the Checkpoint server (e.g. https://checkpoint.example.com). Falls back to the
		/// CHECKPOINT_ENDPOINT environment variable.
		/// </summary>
		public Uri? ServerUrl { get; set; }

		/// <summary>
		/// API token for the service account. Prefer <see cref="TokenEnvVar"/> to avoid storing
		/// secrets in config files.
		/// </summary>
		public string? Token { get; set; }

		/// <summary>
		/// Environment variable to read the API token from when <see cref="Token"/> is unset.
		/// </summary>
		public string TokenEnvVar { get; set; } = "CHECKPOINT_API_TOKEN";

		/// <summary>
		/// Service account user name reported to agents (informational).
		/// </summary>
		public string? ServiceAccount { get; set; }
	}
}
