// Copyright Incanta Games. All Rights Reserved.

using EpicGames.Core;
using EpicGames.Horde.Commits;
using EpicGames.Horde.Streams;
using EpicGames.Horde.Users;
using HordeServer.Streams;

namespace HordeServer.VersionControl.Checkpoint
{
	/// <summary>
	/// ICommit implementation backed by a Checkpoint changelist.
	/// </summary>
	sealed class CheckpointCommit : ICommit
	{
		readonly CheckpointCommitCollection _collection;
		readonly StreamConfig _streamConfig;

		IReadOnlyList<CommitTag>? _cachedTags;

		public int Number { get; }

		/// <inheritdoc/>
		public CommitIdWithOrder Id => CheckpointCommitCollection.ToCommitId(Number);

		/// <inheritdoc/>
		public StreamId StreamId => _streamConfig.Id;

		/// <inheritdoc/>
		public CommitIdWithOrder OriginalCommitId => Id;

		/// <inheritdoc/>
		public UserId AuthorId { get; }

		/// <inheritdoc/>
		public UserId OwnerId => AuthorId;

		/// <inheritdoc/>
		public string Description { get; }

		/// <inheritdoc/>
		public string BasePath { get; }

		/// <inheritdoc/>
		public DateTime DateUtc { get; }

		public CheckpointCommit(CheckpointCommitCollection collection, StreamConfig streamConfig, int number, UserId authorId, string description, string basePath, DateTime dateUtc)
		{
			_collection = collection;
			_streamConfig = streamConfig;
			Number = number;
			AuthorId = authorId;
			Description = description;
			BasePath = basePath;
			DateUtc = dateUtc;
		}

		/// <inheritdoc/>
		public async ValueTask<IReadOnlyList<CommitTag>> GetTagsAsync(CancellationToken cancellationToken)
		{
			if (_cachedTags == null)
			{
				List<CommitTag> tags = new List<CommitTag>();
				foreach (CommitTagConfig tagConfig in _streamConfig.GetAllCommitTags())
				{
					if (_streamConfig.TryGetCommitTagFilter(tagConfig.Name, out FileFilter? filter) && await MatchesFilterAsync(filter, cancellationToken))
					{
						tags.Add(tagConfig.Name);
					}
				}
				_cachedTags = tags;
			}
			return _cachedTags;
		}

		/// <inheritdoc/>
		public async ValueTask<bool> MatchesFilterAsync(FileFilter filter, CancellationToken cancellationToken)
		{
			// Checkpoint returns the complete file list for a changelist, so a single query suffices
			IReadOnlyList<string> files = await _collection.GetCommitFilesAsync(Number, cancellationToken);
			return filter.ApplyTo(files).Any();
		}

		/// <inheritdoc/>
		public async ValueTask<IReadOnlyList<string>> GetFilesAsync(int? minFiles, int? maxFiles, CancellationToken cancellationToken)
		{
			IReadOnlyList<string> files = await _collection.GetCommitFilesAsync(Number, cancellationToken);
			if (maxFiles.HasValue && files.Count > maxFiles.Value)
			{
				files = files.Take(maxFiles.Value).ToArray();
			}
			return files;
		}
	}
}
