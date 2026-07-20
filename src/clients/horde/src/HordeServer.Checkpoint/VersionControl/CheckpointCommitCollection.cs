// Copyright Incanta Games. All Rights Reserved.

using System.Runtime.CompilerServices;
using Checkpoint.Api;
using Checkpoint.Api.Models;
using EpicGames.Horde.Commits;
using EpicGames.Horde.Users;
using HordeServer.Streams;
using HordeServer.Users;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace HordeServer.VersionControl.Checkpoint
{
	/// <summary>
	/// ICommitCollection implementation over the Checkpoint API for a single stream. Checkpoint
	/// changelist numbers are monotonic per repo, so commit ids are the number rendered as a string
	/// and the order is the number itself (mirroring the Perforce convention).
	///
	/// Checkpoint has no push/event API, so SubscribeAsync polls the branch head.
	/// </summary>
	sealed class CheckpointCommitCollection : ICommitCollection
	{
		readonly CheckpointConnectionService _connections;
		readonly StreamConfig _streamConfig;
		readonly IUserCollection _userCollection;
		readonly IMemoryCache _cache;
		readonly ILogger _logger;

		readonly CheckpointClient _client;
		readonly string _repositoryName;
		readonly string _branchName;

		public CheckpointCommitCollection(CheckpointConnectionService connections, StreamConfig streamConfig, IUserCollection userCollection, IMemoryCache cache, ILogger logger)
		{
			_connections = connections;
			_streamConfig = streamConfig;
			_userCollection = userCollection;
			_cache = cache;
			_logger = logger;

			if (String.IsNullOrEmpty(streamConfig.RepositoryName))
			{
				throw new CommitCollectionException($"Stream '{streamConfig.Id}' uses the Checkpoint VCS but does not set 'repositoryName'. Set it to the 'orgName/repoName' of the Checkpoint repository.", null);
			}

			_repositoryName = streamConfig.RepositoryName;
			_branchName = String.IsNullOrEmpty(streamConfig.DefaultBranchName) ? "main" : streamConfig.DefaultBranchName;
			_client = connections.CreateClient(streamConfig.ClusterName);
		}

		/// <summary>
		/// Converts a Checkpoint changelist number to a Horde commit id.
		/// </summary>
		public static CommitIdWithOrder ToCommitId(int number)
			=> new CommitIdWithOrder(number.ToString(System.Globalization.CultureInfo.InvariantCulture), number);

		/// <summary>
		/// Parses a Horde commit id as a Checkpoint changelist number.
		/// </summary>
		public static int ToChangelistNumber(CommitId commitId)
		{
			if (!Int32.TryParse(commitId.Name, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out int number))
			{
				throw new CommitCollectionException($"Commit id '{commitId}' is not a valid Checkpoint changelist number", null);
			}
			return number;
		}

		async ValueTask<string> GetRepoIdAsync(CancellationToken cancellationToken)
		{
			try
			{
				return await _connections.GetRepoIdAsync(_client, _repositoryName, cancellationToken);
			}
			catch (Exception ex) when (ex is TrpcException or InvalidOperationException)
			{
				throw new CommitCollectionException($"Failed resolving Checkpoint repository for stream '{_streamConfig.Id}': {ex.Message}", ex);
			}
		}

		/// <inheritdoc/>
		public Task<CommitIdWithOrder> CreateNewAsync(string path, string description, CancellationToken cancellationToken = default)
			=> throw new CommitCollectionException("Submitting new changes from Horde is not supported by the Checkpoint integration. Remove 'submitNewChange' from the template configuration.", null);

		/// <inheritdoc/>
		public ValueTask<CommitIdWithOrder> GetOrderedAsync(CommitId commitId, CancellationToken cancellationToken = default)
			=> ValueTask.FromResult(ToCommitId(ToChangelistNumber(commitId)));

		/// <inheritdoc/>
		public async Task<ICommit> GetAsync(CommitId commitId, CancellationToken cancellationToken = default)
		{
			int number = ToChangelistNumber(commitId);
			string repoId = await GetRepoIdAsync(cancellationToken);

			ChangelistInfo? changelist;
			try
			{
				changelist = await _client.GetChangelistAsync(repoId, number, cancellationToken);
			}
			catch (TrpcException ex)
			{
				throw new CommitCollectionException($"Failed querying Checkpoint changelist {number}: {ex.Message}", ex);
			}

			if (changelist == null)
			{
				throw new CommitCollectionException($"Changelist {number} does not exist in Checkpoint repository '{_repositoryName}'", null);
			}
			return await CreateCommitAsync(changelist, cancellationToken);
		}

		/// <inheritdoc/>
		public async IAsyncEnumerable<ICommit> FindAsync(CommitId? minCommitId = null, bool includeMinCommit = true, CommitId? maxCommitId = null, bool includeMaxCommit = true, int? maxResults = null, IReadOnlyList<CommitTag>? tags = null, CommitSortOrder sortOrder = CommitSortOrder.Descending, [EnumeratorCancellation] CancellationToken cancellationToken = default)
		{
			int? minNumber = minCommitId != null ? ToChangelistNumber(minCommitId) + (includeMinCommit ? 0 : 1) : null;
			int? maxNumber = maxCommitId != null ? ToChangelistNumber(maxCommitId) - (includeMaxCommit ? 0 : 1) : null;

			if (sortOrder == CommitSortOrder.Descending)
			{
				int count = 0;
				await foreach (ICommit commit in EnumerateDescendingAsync(minNumber, maxNumber, tags, cancellationToken))
				{
					yield return commit;
					if (maxResults != null && ++count >= maxResults.Value)
					{
						yield break;
					}
				}
			}
			else
			{
				// The Checkpoint API only walks history newest-first, so collect the full range and
				// reverse. Ranges are bounded by MaxCommitsPerPoll to keep memory in check.
				List<ICommit> commits = new List<ICommit>();
				await foreach (ICommit commit in EnumerateDescendingAsync(minNumber, maxNumber, tags, cancellationToken))
				{
					commits.Add(commit);
				}
				commits.Reverse();

				IEnumerable<ICommit> result = commits;
				if (maxResults != null)
				{
					result = result.Take(maxResults.Value);
				}
				foreach (ICommit commit in result)
				{
					yield return commit;
				}
			}
		}

		async IAsyncEnumerable<ICommit> EnumerateDescendingAsync(int? minNumber, int? maxNumber, IReadOnlyList<CommitTag>? tags, [EnumeratorCancellation] CancellationToken cancellationToken)
		{
			string repoId = await GetRepoIdAsync(cancellationToken);
			int rangeLimit = _connections.GetCluster(_streamConfig.ClusterName).MaxCommitsPerPoll;

			// Always walk from the branch head: changelist numbers are repo-global, so starting the
			// walk at an arbitrary number could follow another branch's parent chain.
			int? start = null;
			int seen = 0;
			while (seen < rangeLimit)
			{
				List<ChangelistInfo> page;
				try
				{
					page = await _client.GetChangelistsAsync(repoId, _branchName, start, 100, cancellationToken);
				}
				catch (TrpcException ex)
				{
					throw new CommitCollectionException($"Failed querying Checkpoint changelists for stream '{_streamConfig.Id}': {ex.Message}", ex);
				}

				if (page.Count == 0)
				{
					yield break;
				}

				foreach (ChangelistInfo changelist in page)
				{
					cancellationToken.ThrowIfCancellationRequested();

					if (minNumber != null && changelist.Number < minNumber.Value)
					{
						yield break;
					}
					if (maxNumber == null || changelist.Number <= maxNumber.Value)
					{
						seen++;
						ICommit commit = await CreateCommitAsync(changelist, cancellationToken);
						if (await MatchesTagsAsync(commit, tags, cancellationToken))
						{
							yield return commit;
						}
						if (seen >= rangeLimit)
						{
							_logger.LogWarning("Checkpoint commit query for stream {StreamId} hit the range limit of {Limit} changelists; older commits were skipped", _streamConfig.Id, rangeLimit);
							yield break;
						}
					}
				}

				ChangelistInfo last = page[^1];
				if (last.ParentNumber == null || page.Count < 100)
				{
					yield break;
				}
				start = last.ParentNumber;
			}
		}

		/// <inheritdoc/>
		public async IAsyncEnumerable<ICommit> SubscribeAsync(CommitId minCommitId, IReadOnlyList<CommitTag>? tags = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
		{
			int sinceNumber = ToChangelistNumber(minCommitId);
			TimeSpan errorBackoff = TimeSpan.FromSeconds(5.0);

			for (; ; )
			{
				CheckpointClusterConfig cluster = _connections.GetCluster(_streamConfig.ClusterName);
				List<ICommit> newCommits = new List<ICommit>();
				try
				{
					string repoId = await GetRepoIdAsync(cancellationToken);

					// Cheap head probe (single branch read) before walking history
					int? headNumber = await _client.GetHeadNumberAsync(repoId, _branchName, cancellationToken);
					if (headNumber == null)
					{
						throw new CommitCollectionException($"Branch '{_branchName}' does not exist in Checkpoint repository '{_repositoryName}'", null);
					}

					if (headNumber.Value > sinceNumber)
					{
						List<ChangelistInfo> changelists = await _client.GetChangelistsSinceAsync(repoId, _branchName, sinceNumber, cluster.MaxCommitsPerPoll, cancellationToken);
						foreach (ChangelistInfo changelist in changelists)
						{
							newCommits.Add(await CreateCommitAsync(changelist, cancellationToken));
						}
					}

					errorBackoff = TimeSpan.FromSeconds(5.0);
				}
				catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
				{
					throw;
				}
				catch (Exception ex)
				{
					_logger.LogWarning(ex, "Error polling Checkpoint for new commits on stream {StreamId}: {Message}. Retrying in {Backoff}.", _streamConfig.Id, ex.Message, errorBackoff);
					await Task.Delay(errorBackoff, cancellationToken);
					errorBackoff = TimeSpan.FromTicks(Math.Min(errorBackoff.Ticks * 2, TimeSpan.FromMinutes(5.0).Ticks));
					continue;
				}

				foreach (ICommit commit in newCommits)
				{
					if (await MatchesTagsAsync(commit, tags, cancellationToken))
					{
						yield return commit;
					}
					sinceNumber = Math.Max(sinceNumber, ((CheckpointCommit)commit).Number);
				}

				await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, cluster.PollIntervalSeconds)), cancellationToken);
			}
		}

		static async ValueTask<bool> MatchesTagsAsync(ICommit commit, IReadOnlyList<CommitTag>? tags, CancellationToken cancellationToken)
		{
			if (tags == null || tags.Count == 0)
			{
				return true;
			}
			IReadOnlyList<CommitTag> commitTags = await commit.GetTagsAsync(cancellationToken);
			return commitTags.Intersect(tags).Any();
		}

		async ValueTask<CheckpointCommit> CreateCommitAsync(ChangelistInfo changelist, CancellationToken cancellationToken)
		{
			UserId authorId = await ResolveAuthorAsync(changelist.User, cancellationToken);
			string basePath = $"//{_repositoryName}/{_branchName}";
			return new CheckpointCommit(this, _streamConfig, changelist.Number, authorId, changelist.Message, basePath, changelist.CreatedAt.ToUniversalTime());
		}

		async ValueTask<UserId> ResolveAuthorAsync(ChangelistAuthor? author, CancellationToken cancellationToken)
		{
			string login = author?.Username ?? author?.Email ?? "checkpoint";
			string cacheKey = $"checkpoint:user:{login}";

			if (_cache.TryGetValue(cacheKey, out UserId cachedId))
			{
				return cachedId;
			}

			IUser user = await _userCollection.FindOrAddUserByLoginAsync(login, author?.Name ?? author?.Username, author?.Email, cancellationToken);
			using (ICacheEntry entry = _cache.CreateEntry(cacheKey))
			{
				entry.SetSlidingExpiration(TimeSpan.FromHours(1.0));
				entry.SetSize(1);
				entry.SetValue(user.Id);
			}
			return user.Id;
		}

		/// <summary>
		/// Gets the (complete) list of files changed by a changelist, normalized with a leading slash
		/// so Horde FileFilter patterns apply. Cached, since tag evaluation is a hot path.
		/// </summary>
		internal async ValueTask<IReadOnlyList<string>> GetCommitFilesAsync(int number, CancellationToken cancellationToken)
		{
			string repoId = await GetRepoIdAsync(cancellationToken);
			string cacheKey = $"checkpoint:files:{repoId}@{number}";

			if (_cache.TryGetValue(cacheKey, out IReadOnlyList<string>? cachedFiles) && cachedFiles != null)
			{
				return cachedFiles;
			}

			List<ChangelistFileInfo> fileChanges;
			try
			{
				fileChanges = await _client.GetChangelistFilesAsync(repoId, number, cancellationToken);
			}
			catch (TrpcException ex)
			{
				throw new CommitCollectionException($"Failed querying files for Checkpoint changelist {number}: {ex.Message}", ex);
			}

			IReadOnlyList<string> files = fileChanges.Select(x => x.Path.StartsWith('/') ? x.Path : $"/{x.Path}").ToArray();
			using (ICacheEntry entry = _cache.CreateEntry(cacheKey))
			{
				entry.SetSlidingExpiration(TimeSpan.FromMinutes(30.0));
				entry.SetSize(Math.Max(1, files.Count));
				entry.SetValue(files);
			}
			return files;
		}
	}
}
