// Copyright Incanta Games. All Rights Reserved.

using HordeServer.Configuration;
using HordeServer.Plugins;

namespace HordeServer
{
	/// <summary>
	/// Dynamic (globals.json) configuration for the Checkpoint plugin.
	/// </summary>
	public class CheckpointConfig : IPluginConfig
	{
		/// <summary>
		/// Cluster profiles. A Checkpoint stream selects one via its clusterName property; each maps
		/// to a connection profile from the plugin's server config plus polling behavior.
		/// </summary>
		public List<CheckpointClusterConfig> Clusters { get; set; } = new List<CheckpointClusterConfig>();

		/// <inheritdoc/>
		public void PostLoad(PluginConfigOptions configOptions)
		{
		}

		/// <summary>
		/// Finds the cluster profile for the given Horde cluster name. Falls back to an implicit
		/// default profile so a bare setup (single server, env-var credentials) needs no globals config.
		/// </summary>
		public CheckpointClusterConfig GetCluster(string? name)
		{
			CheckpointClusterConfig? cluster = null;
			if (!String.IsNullOrEmpty(name))
			{
				cluster = Clusters.FirstOrDefault(x => String.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
			}
			return cluster ?? Clusters.FirstOrDefault() ?? new CheckpointClusterConfig();
		}
	}

	/// <summary>
	/// Settings for one Checkpoint cluster (a Checkpoint server endpoint plus polling behavior).
	/// </summary>
	public class CheckpointClusterConfig
	{
		/// <summary>
		/// Name of the cluster; matched against StreamConfig.ClusterName for Checkpoint streams and
		/// against the pseudo Perforce cluster defined for agent dispatch.
		/// </summary>
		public string Name { get; set; } = "Checkpoint";

		/// <summary>
		/// Connection profile (from the plugin server config) used to talk to the Checkpoint server.
		/// </summary>
		public string Connection { get; set; } = CheckpointConnectionConfig.DefaultId;

		/// <summary>
		/// Optional endpoint override for this cluster.
		/// </summary>
		public Uri? ServerUrl { get; set; }

		/// <summary>
		/// Optional API token override for this cluster. May reference a secret from the Secrets
		/// plugin using the horde:secret:// syntax.
		/// </summary>
		[ResolveSecret]
		public string? Token { get; set; }

		/// <summary>
		/// Interval between polls for new changelists, in seconds.
		/// </summary>
		public int PollIntervalSeconds { get; set; } = 15;

		/// <summary>
		/// Upper bound on the number of changelists fetched in one catch-up walk. When a stream is
		/// further behind than this, older changelists are skipped.
		/// </summary>
		public int MaxCommitsPerPoll { get; set; } = 1000;
	}
}
