// Copyright Incanta Games. All Rights Reserved.

using HordeServer.Checkpoint;
using HordeServer.Configuration;
using HordeServer.Jobs;
using HordeServer.Perforce;
using HordeServer.Plugins;
using HordeServer.VersionControl;
using HordeServer.VersionControl.Checkpoint;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace HordeServer
{
	/// <summary>
	/// Entry point for the Checkpoint version control plugin. Drop HordeServer.Checkpoint.dll and
	/// Checkpoint.Api.dll into the Horde server directory and enable via Horde:Plugins:Checkpoint.
	/// </summary>
	[Plugin("Checkpoint", EnabledByDefault = false, DependsOn = new[] { "Build", "Compute" }, ServerConfigType = typeof(CheckpointServerConfig), GlobalConfigType = typeof(CheckpointConfig))]
	public class CheckpointPlugin : IPluginStartup
	{
		/// <inheritdoc/>
		public void Configure(IApplicationBuilder app)
		{
		}

		/// <inheritdoc/>
		public void ConfigureServices(IServiceCollection serviceCollection)
		{
			serviceCollection.AddSingleton<CheckpointConnectionService>();

			// Additional VCS provider; CommitService keys providers by name and streams opt in with "vcs": "Checkpoint"
			serviceCollection.AddSingleton<CheckpointVersionControlService>();
			serviceCollection.AddSingleton<IVersionControlService>(sp => sp.GetRequiredService<CheckpointVersionControlService>());

			// Stamps Checkpoint connection details onto agent workspace messages for Checkpoint streams
			serviceCollection.AddSingleton<IWorkspaceMessageEnricher, CheckpointWorkspaceEnricher>();

			// checkpoint:// scheme for Horde config files stored in a Checkpoint repository
			serviceCollection.AddSingleton<IConfigSource, CheckpointConfigSource>();

			// Keeps the placeholder Perforce cluster used by Checkpoint streams healthy for dispatch
			serviceCollection.AddHostedService<CheckpointClusterHealthService>();
		}
	}

	/// <summary>
	/// Helper methods for the Checkpoint plugin config
	/// </summary>
	public static class CheckpointPluginExtensions
	{
		/// <summary>
		/// Configures the Checkpoint plugin
		/// </summary>
		public static void AddCheckpointConfig(this IDictionary<PluginName, IPluginConfig> dictionary, CheckpointConfig checkpointConfig)
			=> dictionary[new PluginName("Checkpoint")] = checkpointConfig;

		/// <summary>
		/// Gets configuration for the Checkpoint plugin
		/// </summary>
		public static CheckpointConfig GetCheckpointConfig(this IDictionary<PluginName, IPluginConfig> dictionary)
			=> (CheckpointConfig)dictionary[new PluginName("Checkpoint")];
	}
}
