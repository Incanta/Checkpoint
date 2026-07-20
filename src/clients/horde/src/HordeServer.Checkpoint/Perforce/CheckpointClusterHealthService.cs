// Copyright Incanta Games. All Rights Reserved.

using HordeServer.Server;
using HordeServer.Utilities;
using HordeServer.VersionControl.Checkpoint;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace HordeServer.Perforce
{
	/// <summary>
	/// Keeps the pseudo Perforce cluster entries used by Checkpoint streams marked as healthy.
	///
	/// Background: agent dispatch requires the stream's cluster to resolve to a healthy entry in the
	/// Perforce load balancer's server list (JobTaskSource/PerforceWorkspace). Checkpoint streams
	/// reference a placeholder cluster whose server is not a real Perforce server, so the load
	/// balancer's periodic "p4 info" probe would mark it unhealthy and jobs would never dispatch.
	///
	/// This service writes Healthy status for those entries into the load balancer's singleton
	/// document with a future-dated LastUpdateTime. The probe only overwrites an entry when its
	/// LastUpdateTime is older than the probe time, so the future timestamp deterministically wins,
	/// and the staleness degrade (7.5 min) never triggers because we refresh every 30 seconds.
	///
	/// NOTE: this mirrors the private BSON shape of PerforceLoadBalancer.PerforceServerList
	/// ("perforce-server-list" singleton). Re-verify the shape when upgrading Horde versions.
	/// </summary>
	public sealed class CheckpointClusterHealthService : BackgroundService
	{
		// Mirror of PerforceLoadBalancer.PerforceServerList (same singleton id and element names)
		[SingletonDocument("perforce-server-list", "6046aec374a9283100967ee7")]
		class PerforceServerListDocument : SingletonBase
		{
			public List<PerforceServerEntryDocument> Servers { get; set; } = new List<PerforceServerEntryDocument>();
		}

		class PerforceServerEntryDocument
		{
			public string ServerAndPort { get; set; } = String.Empty;
			public string BaseServerAndPort { get; set; } = String.Empty;
			public string? HealthCheckUrl { get; set; }
			public string Cluster { get; set; } = String.Empty;
			public bool SupportsPartitionedWorkspaces { get; set; }
			public int Status { get; set; }
			public string? Detail { get; set; }
			public int NumLeases { get; set; }
			public DateTime? LastUpdateTime { get; set; }
		}

		// PerforceServerStatus.Healthy
		const int HealthyStatus = 3;

		static readonly TimeSpan s_tickInterval = TimeSpan.FromSeconds(30.0);
		static readonly TimeSpan s_futureOffset = TimeSpan.FromMinutes(5.0);

		readonly SingletonDocument<PerforceServerListDocument> _serverList;
		readonly IOptionsMonitor<CheckpointConfig> _checkpointConfig;
		readonly IOptionsMonitor<BuildConfig> _buildConfig;
		readonly ILogger<CheckpointClusterHealthService> _logger;

		public CheckpointClusterHealthService(IMongoService mongoService, IOptionsMonitor<CheckpointConfig> checkpointConfig, IOptionsMonitor<BuildConfig> buildConfig, ILogger<CheckpointClusterHealthService> logger)
		{
			_serverList = new SingletonDocument<PerforceServerListDocument>(mongoService);
			_checkpointConfig = checkpointConfig;
			_buildConfig = buildConfig;
			_logger = logger;
		}

		/// <inheritdoc/>
		protected override async Task ExecuteAsync(CancellationToken stoppingToken)
		{
			while (!stoppingToken.IsCancellationRequested)
			{
				try
				{
					await TickAsync(stoppingToken);
				}
				catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
				{
					break;
				}
				catch (Exception ex)
				{
					_logger.LogError(ex, "Error updating Checkpoint pseudo-cluster health: {Message}", ex.Message);
				}

				try
				{
					await Task.Delay(s_tickInterval, stoppingToken);
				}
				catch (OperationCanceledException)
				{
					break;
				}
			}
		}

		async Task TickAsync(CancellationToken cancellationToken)
		{
			// Cluster names used by Checkpoint streams (explicit profiles, or the implicit default)
			HashSet<string> checkpointClusters = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
			foreach (CheckpointClusterConfig cluster in _checkpointConfig.CurrentValue.Clusters)
			{
				checkpointClusters.Add(cluster.Name);
			}
			if (checkpointClusters.Count == 0)
			{
				checkpointClusters.Add(new CheckpointClusterConfig().Name);
			}

			// Match them against the Perforce clusters defined in the build config so we know the
			// placeholder server entries to keep alive
			List<PerforceCluster> clusters = _buildConfig.CurrentValue.PerforceClusters.Where(x => checkpointClusters.Contains(x.Name)).ToList();
			if (clusters.Count == 0)
			{
				return;
			}

			DateTime futureTime = DateTime.UtcNow + s_futureOffset;
			await _serverList.UpdateAsync(serverList =>
			{
				foreach (PerforceCluster cluster in clusters)
				{
					foreach (PerforceServer server in cluster.Servers)
					{
						PerforceServerEntryDocument? entry = serverList.Servers.FirstOrDefault(
							x => String.Equals(x.Cluster, cluster.Name, StringComparison.Ordinal) && String.Equals(x.BaseServerAndPort, server.ServerAndPort, StringComparison.OrdinalIgnoreCase));

						if (entry == null)
						{
							entry = new PerforceServerEntryDocument
							{
								ServerAndPort = server.ServerAndPort,
								BaseServerAndPort = server.ServerAndPort,
								Cluster = cluster.Name,
								SupportsPartitionedWorkspaces = cluster.SupportsPartitionedWorkspaces,
							};
							serverList.Servers.Add(entry);
						}

						entry.HealthCheckUrl = null;
						entry.Status = HealthyStatus;
						entry.Detail = "Checkpoint pseudo-cluster (health maintained by the Checkpoint plugin)";
						entry.LastUpdateTime = futureTime;
					}
				}
			}, cancellationToken);

			_logger.LogDebug("Refreshed health for {NumClusters} Checkpoint pseudo-cluster(s)", clusters.Count);
		}
	}
}
