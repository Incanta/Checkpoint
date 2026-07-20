// Copyright Incanta Games. All Rights Reserved.

using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using Checkpoint.Api;
using Checkpoint.Api.Models;
using EpicGames.Horde.Users;
using HordeServer.Configuration;
using HordeServer.Users;
using HordeServer.VersionControl.Checkpoint;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace HordeServer.Checkpoint
{
	/// <summary>
	/// Config source that reads Horde config files (globals.json, *.horde.json) from a Checkpoint
	/// repository, mirroring PerforceConfigSource. URI format:
	///
	///   checkpoint://[connectionId]/orgName/repoName/branchName/path/to/file.json
	///
	/// The host component names a connection profile from the plugin's server config (empty host
	/// selects the default profile). Branch names containing '/' are not supported in config URIs.
	/// </summary>
	public sealed class CheckpointConfigSource : IConfigSource
	{
		record class ParsedUri(string ConnectionId, string RepositoryName, string BranchName, string FilePath);

		record class FileState(int HeadNumber, int RevisionNumber);

		class ConfigFileImpl : IConfigFile
		{
			public Uri Uri { get; }
			public int Change { get; }
			public string Revision { get; }
			public IUser? Author { get; }

			readonly CheckpointConfigSource _owner;

			public ConfigFileImpl(Uri uri, int change, IUser? author, CheckpointConfigSource owner)
			{
				Uri = uri;
				Change = change;
				Revision = change.ToString(CultureInfo.InvariantCulture);
				Author = author;
				_owner = owner;
			}

			public ValueTask<ReadOnlyMemory<byte>> ReadAsync(CancellationToken cancellationToken)
				=> _owner.ReadAsync(Uri, Change, cancellationToken);
		}

		/// <summary>
		/// Name of the scheme for this source
		/// </summary>
		public const string Scheme = "checkpoint";

		/// <inheritdoc/>
		string IConfigSource.Scheme => Scheme;

		/// <inheritdoc/>
		public TimeSpan UpdateInterval => TimeSpan.FromMinutes(1.0);

		readonly CheckpointConnectionService _connections;
		readonly IUserCollection _userCollection;
		readonly IMemoryCache _cache;
		readonly ILogger _logger;

		// Tracks, per config file, the last branch head we examined and the revision we attributed to
		// the file at that point. Lets us keep a stable Revision (and skip re-reads) when commits land
		// that do not touch the file.
		readonly ConcurrentDictionary<Uri, FileState> _fileStates = new ConcurrentDictionary<Uri, FileState>();

		public CheckpointConfigSource(CheckpointConnectionService connections, IUserCollection userCollection, IMemoryCache cache, ILogger<CheckpointConfigSource> logger)
		{
			_connections = connections;
			_userCollection = userCollection;
			_cache = cache;
			_logger = logger;
		}

		static ParsedUri ParseUri(Uri uri)
		{
			string[] segments = uri.AbsolutePath.TrimStart('/').Split('/');
			if (segments.Length < 4)
			{
				throw new InvalidOperationException($"Invalid Checkpoint config URI '{uri}'. Expected checkpoint://[connection]/org/repo/branch/path/to/file.json");
			}
			return new ParsedUri(uri.Host, $"{segments[0]}/{segments[1]}", segments[2], String.Join('/', segments.Skip(3)));
		}

		async Task<(CheckpointClient Client, string RepoId)> ConnectAsync(ParsedUri parsed, CancellationToken cancellationToken)
		{
			CheckpointClient client = _connections.CreateClientForConnection(parsed.ConnectionId);
			string repoId = await _connections.GetRepoIdAsync(client, parsed.RepositoryName, cancellationToken);
			return (client, repoId);
		}

		/// <inheritdoc/>
		public async Task<IConfigFile[]> GetFilesAsync(Uri[] uris, CancellationToken cancellationToken)
		{
			Dictionary<Uri, IConfigFile> results = new Dictionary<Uri, IConfigFile>();
			foreach (Uri uri in uris.Distinct())
			{
				ParsedUri parsed = ParseUri(uri);
				(CheckpointClient client, string repoId) = await ConnectAsync(parsed, cancellationToken);

				BranchInfo? branch = await client.GetBranchAsync(repoId, parsed.BranchName, cancellationToken);
				if (branch == null)
				{
					throw new FileNotFoundException($"Unable to read {uri}. Branch '{parsed.BranchName}' not found in repository '{parsed.RepositoryName}'.");
				}

				int revision = await GetFileRevisionAsync(uri, parsed, client, repoId, branch.HeadNumber, cancellationToken);
				IUser? author = await GetAuthorAsync(client, repoId, revision, cancellationToken);
				results[uri] = new ConfigFileImpl(uri, revision, author, this);
			}
			return Array.ConvertAll(uris, x => results[x]);
		}

		/// <summary>
		/// Determines the changelist number to attribute to a config file at the current branch head,
		/// only advancing the revision when a commit in (lastHead, head] touched the file.
		/// </summary>
		async ValueTask<int> GetFileRevisionAsync(Uri uri, ParsedUri parsed, CheckpointClient client, string repoId, int headNumber, CancellationToken cancellationToken)
		{
			if (_fileStates.TryGetValue(uri, out FileState? state))
			{
				if (headNumber <= state.HeadNumber)
				{
					return state.RevisionNumber;
				}

				List<string> changedPaths = await client.GetFilePathsChangedBetweenAsync(repoId, state.HeadNumber, headNumber, cancellationToken);
				bool fileChanged = changedPaths.Any(x => String.Equals(x.TrimStart('/'), parsed.FilePath, StringComparison.OrdinalIgnoreCase));

				FileState newState = new FileState(headNumber, fileChanged ? headNumber : state.RevisionNumber);
				_fileStates[uri] = newState;
				return newState.RevisionNumber;
			}
			else
			{
				// First sighting: verify the file exists at head, and attribute it to the head change
				FileContentInfo content = await ReadFileOrThrowAsync(uri, client, repoId, headNumber, parsed.FilePath, cancellationToken);
				CacheContent(uri, headNumber, content);

				_fileStates[uri] = new FileState(headNumber, headNumber);
				return headNumber;
			}
		}

		async ValueTask<IUser?> GetAuthorAsync(CheckpointClient client, string repoId, int change, CancellationToken cancellationToken)
		{
			string cacheKey = $"{nameof(CheckpointConfigSource)}:author:{repoId}@{change}";
			if (!_cache.TryGetValue(cacheKey, out ChangelistAuthor? author))
			{
				ChangelistInfo? changelist = await client.GetChangelistAsync(repoId, change, cancellationToken);
				author = changelist?.User;
				using (ICacheEntry entry = _cache.CreateEntry(cacheKey))
				{
					entry.SetSlidingExpiration(TimeSpan.FromHours(1.0));
					entry.SetSize(1);
					entry.SetValue(author);
				}
			}

			if (author == null)
			{
				return null;
			}
			return await _userCollection.FindUserByLoginAsync(author.Username ?? author.Email, cancellationToken);
		}

		async ValueTask<ReadOnlyMemory<byte>> ReadAsync(Uri uri, int change, CancellationToken cancellationToken)
		{
			string cacheKey = $"{nameof(CheckpointConfigSource)}:data:{uri}@{change}";
			if (_cache.TryGetValue(cacheKey, out ReadOnlyMemory<byte> data))
			{
				return data;
			}

			_logger.LogInformation("Reading {Uri} at CL {Change} from Checkpoint", uri, change);
			ParsedUri parsed = ParseUri(uri);
			(CheckpointClient client, string repoId) = await ConnectAsync(parsed, cancellationToken);

			FileContentInfo content = await ReadFileOrThrowAsync(uri, client, repoId, change, parsed.FilePath, cancellationToken);
			return CacheContent(uri, change, content);
		}

		async Task<FileContentInfo> ReadFileOrThrowAsync(Uri uri, CheckpointClient client, string repoId, int change, string filePath, CancellationToken cancellationToken)
		{
			FileContentInfo content;
			try
			{
				content = await client.ReadFileContentAsync(repoId, change, filePath, cancellationToken);
			}
			catch (TrpcException ex) when (ex.IsNotFound)
			{
				throw new FileNotFoundException($"Unable to read {uri}. No matching file found at CL {change}.", ex);
			}

			if (content.Content == null)
			{
				string reason = content.IsBinary ? "the file is binary" : (content.TooLarge == true ? "the file is too large" : "no content was returned");
				throw new InvalidDataException($"Unable to read {uri} at CL {change}: {reason}.");
			}
			return content;
		}

		ReadOnlyMemory<byte> CacheContent(Uri uri, int change, FileContentInfo content)
		{
			ReadOnlyMemory<byte> data = Encoding.UTF8.GetBytes(content.Content ?? String.Empty);
			string cacheKey = $"{nameof(CheckpointConfigSource)}:data:{uri}@{change}";
			using (ICacheEntry entry = _cache.CreateEntry(cacheKey))
			{
				entry.SetSlidingExpiration(TimeSpan.FromHours(1.0));
				entry.SetSize(data.Length);
				entry.SetValue(data);
			}
			return data;
		}

		/// <inheritdoc/>
		public async Task GetUpdateInfoAsync(IReadOnlyDictionary<Uri, string> files, IReadOnlyDictionary<Uri, string>? prevFiles, ConfigUpdateInfo updateInfo, CancellationToken cancellationToken)
		{
			foreach (IGrouping<string, KeyValuePair<Uri, string>> group in files.Where(x => x.Key.Scheme == Scheme).GroupBy(x => x.Key.Host))
			{
				int change = group.Select(x => Int32.Parse(x.Value, CultureInfo.InvariantCulture)).Max();
				updateInfo.Status.Add($"Checkpoint changelist ({group.Key}): {change}");

				if (prevFiles != null)
				{
					foreach ((Uri uri, string revision) in group)
					{
						string? prevRevision;
						if (prevFiles.TryGetValue(uri, out prevRevision) && prevRevision != revision)
						{
							await FindAuthorsAsync(uri, Int32.Parse(prevRevision, CultureInfo.InvariantCulture), Int32.Parse(revision, CultureInfo.InvariantCulture), updateInfo.Authors, cancellationToken);
						}
					}
				}
			}
		}

		async Task FindAuthorsAsync(Uri uri, int prevChange, int newChange, HashSet<UserId> authors, CancellationToken cancellationToken)
		{
			try
			{
				ParsedUri parsed = ParseUri(uri);
				(CheckpointClient client, string repoId) = await ConnectAsync(parsed, cancellationToken);

				List<ChangelistInfo> changelists = await client.GetChangelistsSinceAsync(repoId, parsed.BranchName, prevChange, maxResults: 100, cancellationToken);
				foreach (ChangelistInfo changelist in changelists.Where(x => x.Number <= newChange && x.User != null))
				{
					IUser? user = await _userCollection.FindUserByLoginAsync(changelist.User!.Username ?? changelist.User.Email, cancellationToken);
					if (user != null)
					{
						authors.Add(user.Id);
					}
				}
			}
			catch (Exception ex)
			{
				_logger.LogWarning(ex, "Unable to find authors for config update of {Uri}: {Message}", uri, ex.Message);
			}
		}
	}
}
