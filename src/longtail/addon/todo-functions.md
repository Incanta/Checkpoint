<!-- longtaillib.CreateFullHashRegistry() -->
<!-- longtaillib.CreateFSStorageAPI() -->
<!-- longtaillib.CreateBikeshedJobAPI(uint32(numWorkerCount), 0) -->
<!-- longtaillib.CreateFullCompressionRegistry() -->
<!-- longtaillib.Longtail_BlockStoreAPI
longtaillib.CreateCompressBlockStore(remoteStore, creg) -->
longtaillib.CreateFSBlockStore(jobs, localFS, longtailstorelib.NormalizeFileSystemPath(localCachePath), "", enableFileMapping)
longtaillib.CreateCacheBlockStore(jobs, localIndexStore, remoteIndexStore)
<!-- longtaillib.CreateLRUBlockStoreAPI(compressBlockStore, 32)
longtaillib.CreateShareBlockStore(lruBlockStore) -->
<!-- longtaillib.Longtail_Hash -->
longtaillib.MergeVersionIndexWithRemovals(baseVersionIndex, vindex, hashApi, removedFilesHashes)
longtaillib.MergeVersionIndex(baseVersionIndex, vindex)
longtaillib.CreateMissingContent(hash, existingRemoteStoreIndex, vindex, targetBlockSize, maxChunksPerBlock)
longtaillib.WriteContent(fs, indexStore, jobs, &writeContentProgress, versionMissingStoreIndex, vindex, longtailstorelib.NormalizeFileSystemPath(sourceFolderPath))
longtaillib.WriteVersionIndexToBuffer(vindex)
longtaillib.MergeStoreIndex(existingRemoteStoreIndex, versionMissingStoreIndex)
longtaillib.WriteStoreIndexToBuffer(versionLocalStoreIndex)
<!-- longtaillib.Longtail_VersionIndex -->
<!-- longtaillib.FileExists(fs, cacheTargetIndexPath) -->
<!-- longtaillib.CreateVersionDiff(hash, targetVersionIndex, sourceVersionIndex) -->
longtaillib.GetRequiredChunkHashes(sourceVersionIndex, versionDiff)
<!-- longtaillib.DeleteFile(fs, cacheTargetIndexPath) -->
longtaillib.ChangeVersion(indexStore, fs, hash, jobs, &changeVersionProgress, retargettedVersionStoreIndex, targetVersionIndex, sourceVersionIndex, versionDiff, longtailstorelib.NormalizeFileSystemPath(resolvedTargetFolderPath), retainPermissions)
longtaillib.GetFilesRecursively(fs, pathFilter, longtailstorelib.NormalizeFileSystemPath(resolvedTargetFolderPath))
longtaillib.CreateHPCDCChunkerAPI()
longtaillib.CreateVersionIndex(fs, hash, chunker, jobs, &createVersionIndexProgress, longtailstorelib.NormalizeFileSystemPath(resolvedTargetFolderPath), validateFileInfos, nil, targetChunkSize, enableFileMapping)
longtaillib.WriteVersionIndex(fs, sourceVersionIndex, cacheTargetIndexPath)