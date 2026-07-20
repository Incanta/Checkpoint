// Copyright Incanta Games. All Rights Reserved.

using EpicGames.Horde.Commits;
using HordeServer.Streams;
using HordeServer.Users;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace HordeServer.VersionControl.Checkpoint
{
	/// <summary>
	/// Registers Checkpoint as a version control provider. Streams opt in by setting
	/// "vcs": "Checkpoint" in their stream config; CommitService dispatches to this service by name.
	/// </summary>
	public sealed class CheckpointVersionControlService : IVersionControlService
	{
		/// <summary>
		/// Value for StreamConfig.VCS selecting this provider.
		/// </summary>
		public const string VcsName = "Checkpoint";

		readonly CheckpointConnectionService _connections;
		readonly IUserCollection _userCollection;
		readonly IMemoryCache _cache;
		readonly ILogger<CheckpointVersionControlService> _logger;

		/// <inheritdoc/>
		public string Name => VcsName;

		public CheckpointVersionControlService(CheckpointConnectionService connections, IUserCollection userCollection, IMemoryCache cache, ILogger<CheckpointVersionControlService> logger)
		{
			_connections = connections;
			_userCollection = userCollection;
			_cache = cache;
			_logger = logger;
		}

		/// <inheritdoc/>
		public ICommitCollection GetCommits(StreamConfig streamConfig)
			=> new CheckpointCommitCollection(_connections, streamConfig, _userCollection, _cache, _logger);
	}
}
