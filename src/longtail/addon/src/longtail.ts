import koffi from "koffi";
import path from "path";

export class Longtail {
  private static instance: Longtail;

  public lib: koffi.IKoffiLib;

  public CreateFSStorageAPI: koffi.KoffiFunction;
  public CreateInMemStorageAPI: koffi.KoffiFunction;

  public Storage_OpenReadFile: koffi.KoffiFunction;
  public Storage_GetSize: koffi.KoffiFunction;
  public Storage_Read: koffi.KoffiFunction;
  public Storage_OpenWriteFile: koffi.KoffiFunction;
  public Storage_Write: koffi.KoffiFunction;
  public Storage_SetSize: koffi.KoffiFunction;
  public Storage_SetPermissions: koffi.KoffiFunction;
  public Storage_GetPermissions: koffi.KoffiFunction;
  public Storage_CloseFile: koffi.KoffiFunction;
  public Storage_CreateDir: koffi.KoffiFunction;
  public Storage_RenameFile: koffi.KoffiFunction;
  public Storage_ConcatPath: koffi.KoffiFunction;
  public Storage_IsDir: koffi.KoffiFunction;
  public Storage_IsFile: koffi.KoffiFunction;
  public Storage_RemoveDir: koffi.KoffiFunction;
  public Storage_RemoveFile: koffi.KoffiFunction;
  public Storage_StartFind: koffi.KoffiFunction;
  public Storage_FindNext: koffi.KoffiFunction;
  public Storage_CloseFind: koffi.KoffiFunction;
  public Storage_GetEntryProperties: koffi.KoffiFunction;
  public Storage_LockFile: koffi.KoffiFunction;
  public Storage_UnlockFile: koffi.KoffiFunction;
  public Storage_GetParentPath: koffi.KoffiFunction;
  public Storage_MapFile: koffi.KoffiFunction;
  public Storage_UnmapFile: koffi.KoffiFunction;

  public Hash_GetIdentifier: koffi.KoffiFunction;
  public Hash_BeginContext: koffi.KoffiFunction;
  public Hash_Hash: koffi.KoffiFunction;
  public Hash_EndContext: koffi.KoffiFunction;
  public Hash_HashBuffer: koffi.KoffiFunction;

  public HashRegistry_GetHashAPI: koffi.KoffiFunction;

  public CreateFullHashRegistry: koffi.KoffiFunction;

  public CreateBikeshedJobAPI: koffi.KoffiFunction;

  public CreateFullCompressionRegistry: koffi.KoffiFunction;

  public BlockStore_PutStoredBlock: koffi.KoffiFunction;
  public BlockStore_PreflightGet: koffi.KoffiFunction;
  public BlockStore_GetStoredBlock: koffi.KoffiFunction;
  public BlockStore_GetExistingContent: koffi.KoffiFunction;
  public BlockStore_PruneBlocks: koffi.KoffiFunction;
  public BlockStore_Flush: koffi.KoffiFunction;

  public ReadVersionIndexFromBuffer: koffi.KoffiFunction;
  public ReadStoreIndexFromBuffer: koffi.KoffiFunction;
  public ReadStoredBlockFromBuffer: koffi.KoffiFunction;

  public MakeBlockStoreAPI: koffi.KoffiFunction;

  public Alloc: koffi.KoffiFunction;
  public Free: koffi.KoffiFunction;

  public CreateCompressBlockStoreAPI: koffi.KoffiFunction;
  public CreateLRUBlockStoreAPI: koffi.KoffiFunction;
  public CreateShareBlockStoreAPI: koffi.KoffiFunction;

  public CreateVersionDiff: koffi.KoffiFunction;
  public GetRequiredChunkHashes: koffi.KoffiFunction;
  public CreateVersionIndex: koffi.KoffiFunction;

  public CreateHPCDCChunkerAPI: koffi.KoffiFunction;

  public ChangeVersion: koffi.KoffiFunction;

  private constructor() {
    this.lib = koffi.load(
      path.join(
        __dirname,
        "..",
        "src",
        "longtail",
        "win32_x64",
        "debug",
        "longtail_dylib.dll",
      ),
    );

    koffi.proto("void Longtail_DisposeFunc(void* obj)");

    koffi.struct("Longtail_API", {
      Dispose: "Longtail_DisposeFunc*",
    });

    koffi.pointer("Longtail_StorageAPI_HOpenFile", koffi.opaque() as any);
    koffi.pointer("Longtail_StorageAPI_HIterator", koffi.opaque() as any);
    koffi.pointer("Longtail_StorageAPI_HLockFile", koffi.opaque() as any);
    koffi.pointer("Longtail_StorageAPI_HFileMap", koffi.opaque() as any);
    koffi.pointer("Longtail_HashAPI_HContext", koffi.opaque() as any);

    koffi.struct("Longtail_StorageAPI_EntryProperties", {
      m_Name: "const char*",
      m_Size: "uint64_t",
      m_Permissions: "uint16_t",
      m_IsDir: "int",
    });

    this.Storage_OpenReadFile = this.lib.func(
      "int Longtail_Storage_OpenReadFile(void* storage_api, const char* path, _Out_ Longtail_StorageAPI_HOpenFile* out_open_file)",
    );
    this.Storage_GetSize = this.lib.func(
      "int Longtail_Storage_GetSize(void* storage_api, Longtail_StorageAPI_HOpenFile f, _Out_ uint64_t* out_size)",
    );
    this.Storage_Read = this.lib.func(
      "int Longtail_Storage_Read(void* storage_api, Longtail_StorageAPI_HOpenFile f, uint64_t offset, uint64_t length, _Out_ void* output)",
    );
    this.Storage_OpenWriteFile = this.lib.func(
      "int Longtail_Storage_OpenWriteFile(void* storage_api, const char* path, uint64_t initial_size, _Out_ Longtail_StorageAPI_HOpenFile* out_open_file)",
    );
    this.Storage_Write = this.lib.func(
      "int Longtail_Storage_Write(void* storage_api, Longtail_StorageAPI_HOpenFile f, uint64_t offset, uint64_t length, const void* input)",
    );
    this.Storage_SetSize = this.lib.func(
      "int Longtail_Storage_SetSize(void* storage_api, Longtail_StorageAPI_HOpenFile f, uint64_t length)",
    );
    this.Storage_SetPermissions = this.lib.func(
      "int Longtail_Storage_SetPermissions(void* storage_api, const char* path, uint16_t permissions)",
    );
    this.Storage_GetPermissions = this.lib.func(
      "int Longtail_Storage_GetPermissions(void* storage_api, const char* path, _Out_ uint16_t* out_permissions)",
    );
    this.Storage_CloseFile = this.lib.func(
      "void Longtail_Storage_CloseFile(void* storage_api, Longtail_StorageAPI_HOpenFile f)",
    );
    this.Storage_CreateDir = this.lib.func(
      "int Longtail_Storage_CreateDir(void* storage_api, const char* path)",
    );
    this.Storage_RenameFile = this.lib.func(
      "int Longtail_Storage_RenameFile(void* storage_api, const char* source_path, const char* target_path)",
    );
    this.Storage_ConcatPath = this.lib.func(
      "char* Longtail_Storage_ConcatPath(void* storage_api, const char* root_path, const char* sub_path)",
    );
    this.Storage_IsDir = this.lib.func(
      "int Longtail_Storage_IsDir(void* storage_api, const char* path)",
    );
    this.Storage_IsFile = this.lib.func(
      "int Longtail_Storage_IsFile(void* storage_api, const char* path)",
    );
    this.Storage_RemoveDir = this.lib.func(
      "int Longtail_Storage_RemoveDir(void* storage_api, const char* path)",
    );
    this.Storage_RemoveFile = this.lib.func(
      "int Longtail_Storage_RemoveFile(void* storage_api, const char* path)",
    );
    this.Storage_StartFind = this.lib.func(
      "int Longtail_Storage_StartFind(void* storage_api, const char* path, _Out_ Longtail_StorageAPI_HIterator* out_iterator)",
    );
    this.Storage_FindNext = this.lib.func(
      "int Longtail_Storage_FindNext(void* storage_api, Longtail_StorageAPI_HIterator iterator)",
    );
    this.Storage_CloseFind = this.lib.func(
      "void Longtail_Storage_CloseFind(void* storage_api, Longtail_StorageAPI_HIterator iterator)",
    );
    this.Storage_GetEntryProperties = this.lib.func(
      "int Longtail_Storage_GetEntryProperties(void* storage_api, Longtail_StorageAPI_HIterator iterator, _Out_ Longtail_StorageAPI_EntryProperties* out_properties)",
    );
    this.Storage_LockFile = this.lib.func(
      "int Longtail_Storage_LockFile(void* storage_api, const char* path, _Out_ Longtail_StorageAPI_HLockFile* out_lock_file)",
    );
    this.Storage_UnlockFile = this.lib.func(
      "int Longtail_Storage_UnlockFile(void* storage_api, Longtail_StorageAPI_HLockFile lock_file)",
    );
    this.Storage_GetParentPath = this.lib.func(
      "char* Longtail_Storage_GetParentPath(void* storage_api, const char* path)",
    );
    this.Storage_MapFile = this.lib.func(
      "int Longtail_Storage_MapFile(void* storage_api, Longtail_StorageAPI_HOpenFile f, uint64_t offset, uint64_t length, _Out_ Longtail_StorageAPI_HFileMap* out_file_map, _Out_ const void** out_data_ptr)",
    );
    this.Storage_UnmapFile = this.lib.func(
      "void Longtail_Storage_UnmapFile(void* storage_api, Longtail_StorageAPI_HFileMap m)",
    );

    koffi.struct("Longtail_StorageAPI", {
      m_API: "Longtail_API",
      OpenReadFile: "void*",
      GetSize: "void*",
      Read: "void*",
      OpenWriteFile: "void*",
      Write: "void*",
      SetSize: "void*",
      SetPermissions: "void*",
      GetPermissions: "void*",
      CloseFile: "void*",
      CreateDir: "void*",
      RenameFile: "void*",
      ConcatPath: "void*",
      IsDir: "void*",
      IsFile: "void*",
      RemoveDir: "void*",
      RemoveFile: "void*",
      StartFind: "void*",
      FindNext: "void*",
      CloseFind: "void*",
      GetEntryProperties: "void*",
      LockFile: "void*",
      UnlockFile: "void*",
      GetParentPath: "void*",
      MapFile: "void*",
      UnMapFile: "void*",
    });

    this.CreateFSStorageAPI = this.lib.func(
      "Longtail_StorageAPI* Longtail_CreateFSStorageAPI()",
    );
    this.CreateInMemStorageAPI = this.lib.func(
      "Longtail_StorageAPI* Longtail_CreateInMemStorageAPI()",
    );

    this.Hash_GetIdentifier = this.lib.func(
      "uint32_t Longtail_Hash_GetIdentifier(void* hash_api)",
    );
    this.Hash_BeginContext = this.lib.func(
      "int Longtail_Hash_BeginContext(void* hash_api, _Out_ Longtail_HashAPI_HContext* out_context)",
    );
    this.Hash_Hash = this.lib.func(
      "void Longtail_Hash_Hash(void* hash_api, Longtail_HashAPI_HContext context, uint32_t length, const void* data)",
    );
    this.Hash_EndContext = this.lib.func(
      "uint64_t Longtail_Hash_EndContext(void* hash_api, Longtail_HashAPI_HContext context)",
    );
    this.Hash_HashBuffer = this.lib.func(
      "int Longtail_Hash_HashBuffer(void* hash_api, uint32_t length, const void* data, _Out_ uint64_t* out_hash)",
    );

    koffi.struct("Longtail_HashAPI", {
      m_API: "Longtail_API",
      GetIdentifier: "void*",
      BeginContext: "void*",
      Hash: "void*",
      EndContext: "void*",
      HashBuffer: "void*",
    });

    this.HashRegistry_GetHashAPI = this.lib.func(
      "int Longtail_GetHashRegistry_GetHashAPI(void* hash_registry, uint32_t hash_type, _Out_ Longtail_HashAPI** out_hash_api)",
    );

    koffi.struct("Longtail_HashRegistryAPI", {
      m_API: "Longtail_API",
      GetHashAPI: "void*",
    });

    this.CreateFullHashRegistry = this.lib.func(
      "Longtail_HashRegistryAPI* Longtail_CreateFullHashRegistry()",
    );

    koffi.alias("TLongtail_Hash", "uint64_t");

    koffi.pointer("Longtail_JobAPI", koffi.opaque() as any);

    this.CreateBikeshedJobAPI = this.lib.func(
      "Longtail_JobAPI* Longtail_CreateBikeshedJobAPI(uint32_t worker_count, int worker_priority)",
    );

    koffi.proto(
      "void Longtail_Progress_OnProgressFunc(void* progressApi, uint32_t total_count, uint32_t done_count)",
    );

    koffi.struct("Longtail_ProgressAPI", {
      m_API: "Longtail_API",
      OnProgress: "Longtail_Progress_OnProgressFunc*",
    });

    koffi.pointer("Longtail_CancelAPI", koffi.opaque() as any);
    koffi.pointer("Longtail_CancelAPI_HCancelToken", koffi.opaque() as any);

    koffi.pointer("Longtail_CompressionRegistryAPI", koffi.opaque() as any);

    this.CreateFullCompressionRegistry = this.lib.func(
      "Longtail_CompressionRegistryAPI* Longtail_CreateFullCompressionRegistry()",
    );

    koffi.struct("Longtail_BlockIndex", {
      m_BlockHash: "TLongtail_Hash*",
      m_HashIdentifier: "uint32_t*",
      m_ChunkCount: "uint32_t*",
      m_Tag: "uint32_t*",
      m_ChunkHashes: "TLongtail_Hash*", // []
      m_ChunkSizes: "uint32_t*", // []
    });

    koffi.struct("Longtail_StoreIndex", {
      m_Version: "uint32*",
      m_HashIdentifier: "uint32*",
      m_BlockCount: "uint32*",
      m_ChunkCount: "uint32*",
      m_BlockHashes: "TLongtail_Hash*", // []
      m_ChunkHashes: "TLongtail_Hash*", // []
      m_BlockChunksOffsets: "uint32_t*", // []
      m_BlockChunkCounts: "uint32_t*", // []
      m_BlockTags: "uint32_t*", // []
      m_ChunkSizes: "uint32_t*", // []
    });

    koffi.struct("Longtail_StoredBlock", {
      Dispose: "Longtail_DisposeFunc*",
      m_BlockIndex: "Longtail_BlockIndex*",
      m_BlockData: "uint8*",
      m_BlockChunksDataSize: "uint32_t",
    });

    koffi.proto(
      `void Longtail_AsyncPutStoredBlock_OnCompleteFunc(
        void* async_complete_api,
        int err)`,
    );

    koffi.struct("Longtail_AsyncPutStoredBlockAPI", {
      m_API: "Longtail_API",
      OnComplete: "Longtail_AsyncPutStoredBlock_OnCompleteFunc*",
    });

    this.BlockStore_PutStoredBlock = this.lib.func(
      `int Longtail_BlockStore_PutStoredBlock(
        void* block_store_api,
        Longtail_StoredBlock* stored_block,
        Longtail_AsyncPutStoredBlockAPI* async_complete_api)`,
    );

    koffi.proto(
      `void Longtail_AsyncPreflightStarted_OnCompleteFunc(
        void* async_complete_api,
        uint32_t block_count,
        TLongtail_Hash* block_hashes,
        int err)`,
    );

    koffi.struct("Longtail_AsyncPreflightStartedAPI", {
      m_API: "Longtail_API",
      OnComplete: "Longtail_AsyncPreflightStarted_OnCompleteFunc*",
    });

    this.BlockStore_PreflightGet = this.lib.func(
      `int Longtail_BlockStore_PreflightGet(
        void* block_store_api,
        uint32_t chunk_count,
        const TLongtail_Hash* chunk_hashes,
        Longtail_AsyncPreflightStartedAPI* optional_async_complete_api)`,
    );

    koffi.proto(
      `void Longtail_AsyncGetStoredBlock_OnCompleteFunc(
        void* async_complete_api,
        Longtail_StoredBlock* stored_block,
        int err)`,
    );

    koffi.struct("Longtail_AsyncGetStoredBlockAPI", {
      m_API: "Longtail_API",
      OnComplete: "Longtail_AsyncGetStoredBlock_OnCompleteFunc*",
    });

    this.BlockStore_GetStoredBlock = this.lib.func(
      `int Longtail_BlockStore_GetStoredBlock(
        void* block_store_api,
        uint64_t block_hash,
        Longtail_AsyncGetStoredBlockAPI* async_complete_api)`,
    );

    koffi.proto(
      `void Longtail_AsyncGetExistingContent_OnCompleteFunc(
        void* async_complete_api,
        Longtail_StoreIndex* store_index,
        int err)`,
    );

    koffi.struct("Longtail_AsyncGetExistingContentAPI", {
      m_API: "Longtail_API",
      OnComplete: "Longtail_AsyncGetExistingContent_OnCompleteFunc*",
    });

    this.BlockStore_GetExistingContent = this.lib.func(
      `int Longtail_BlockStore_GetExistingContent(
        void* block_store_api,
        uint32_t chunk_count,
        const TLongtail_Hash* chunk_hashes,
        uint32_t min_block_usage_percent,
        Longtail_AsyncGetExistingContentAPI* async_complete_api)`,
    );

    koffi.proto(
      `void Longtail_AsyncPruneBlocks_OnCompleteFunc(
        void* async_complete_api,
        uint32_t pruned_block_count,
        int err)`,
    );

    koffi.struct("Longtail_AsyncPruneBlocksAPI", {
      m_API: "Longtail_API",
      OnComplete: "Longtail_AsyncPruneBlocks_OnCompleteFunc*",
    });

    this.BlockStore_PruneBlocks = this.lib.func(
      `int Longtail_BlockStore_PruneBlocks(
        void* block_store_api,
        uint32_t block_keep_count,
        const TLongtail_Hash* block_keep_hashes,
        Longtail_AsyncPruneBlocksAPI* async_complete_api)`,
    );

    koffi.proto(
      `void Longtail_AsyncFlush_OnCompleteFunc(
        void* async_complete_api,
        int err)`,
    );

    koffi.struct("Longtail_AsyncFlushAPI", {
      m_API: "Longtail_API",
      OnComplete: "Longtail_AsyncFlush_OnCompleteFunc*",
    });

    this.BlockStore_Flush = this.lib.func(
      `int Longtail_BlockStore_Flush(
        void* block_store_api,
        Longtail_AsyncFlushAPI* async_complete_api)`,
    );

    koffi.struct("Longtail_BlockStoreAPI", {
      m_API: "Longtail_API",
      PutStoredBlock: "void*",
      PreflightGet: "void*",
      GetStoredBlock: "void*",
      GetExistingContent: "void*",
      PruneBlocks: "void*",
      GetStats: "void*",
      Flush: "void*",
    });

    koffi.struct("Longtail_VersionIndex", {
      m_Version: "uint32_t*",
      m_HashIdentifier: "uint32_t*",
      m_TargetChunkSize: "uint32_t*",
      m_AssetCount: "uint32_t*",
      m_ChunkCount: "uint32_t*",
      m_AssetChunkIndexCount: "uint32_t*",
      m_PathHashes: "TLongtail_Hash*",
      m_ContentHashes: "TLongtail_Hash*",
      m_AssetSizes: "uint64_t*",
      m_AssetChunkCounts: "uint32_t*",
      m_AssetChunkIndexStarts: "uint32_t*",
      m_AssetChunkIndexes: "uint32_t*",
      m_ChunkHashes: "TLongtail_Hash*",
      m_ChunkSizes: "uint32_t*",
      m_ChunkTags: "uint32_t*",
      m_NameOffsets: "uint32_t*",
      m_NameDataSize: "uint32_t",
      m_Permissions: "uint16_t*",
      m_NameData: "void*",
    });

    this.ReadVersionIndexFromBuffer = this.lib.func(
      "int Longtail_ReadVersionIndexFromBuffer(const void* buffer, size_t size, _Out_ Longtail_VersionIndex** out_version_index)",
    );

    this.ReadStoreIndexFromBuffer = this.lib.func(
      "int Longtail_ReadStoreIndexFromBuffer(const void* buffer, size_t size, _Out_ Longtail_StoreIndex** out_store_index)",
    );

    this.ReadStoredBlockFromBuffer = this.lib.func(
      `int Longtail_ReadStoredBlockFromBuffer(
        const void* buffer,
        size_t size,
        _Out_ Longtail_StoredBlock** out_stored_block)`,
    );

    koffi.proto(
      `int Longtail_BlockStore_PutStoredBlockFunc(
        Longtail_BlockStoreAPI* block_store_api,
        Longtail_StoredBlock* stored_block,
        Longtail_AsyncPutStoredBlockAPI* async_complete_api
      )`,
    );

    koffi.proto(
      `int Longtail_BlockStore_PreflightGetFunc(
        Longtail_BlockStoreAPI* block_store_api,
        uint32_t block_count,
        const TLongtail_Hash* block_hashes,
        Longtail_AsyncPreflightStartedAPI* optional_async_complete_api
      )`,
    );

    koffi.proto(
      `int Longtail_BlockStore_GetStoredBlockFunc(
        Longtail_BlockStoreAPI* block_store_api,
        uint64_t block_hash,
        Longtail_AsyncGetStoredBlockAPI* async_complete_api
      )`,
    );

    koffi.proto(
      `int Longtail_BlockStore_GetExistingContentFunc(
        Longtail_BlockStoreAPI* block_store_api,
        uint32_t chunk_count,
        const TLongtail_Hash* chunk_hashes,
        uint32_t min_block_usage_percent,
        Longtail_AsyncGetExistingContentAPI* async_complete_api
      )`,
    );

    koffi.proto(
      `int Longtail_BlockStore_PruneBlocksFunc(
        Longtail_BlockStoreAPI* block_store_api,
        uint32_t block_keep_count,
        const TLongtail_Hash* block_keep_hashes,
        Longtail_AsyncPruneBlocksAPI* async_complete_api
      )`,
    );

    koffi.proto(
      `int Longtail_BlockStore_GetStatsFunc(
        Longtail_BlockStoreAPI* block_store_api,
        _Out_ void* out_stats
      )`,
    );

    koffi.proto(
      `int Longtail_BlockStore_FlushFunc(
        Longtail_BlockStoreAPI* block_store_api,
        uint32_t block_keep_count,
        const TLongtail_Hash* block_keep_hashes,
        Longtail_AsyncPruneBlocksAPI* async_complete_api
      )`,
    );

    this.MakeBlockStoreAPI = this.lib.func(
      `Longtail_BlockStoreAPI* Longtail_MakeBlockStoreAPI(
        void* mem,
        Longtail_DisposeFunc* dispose_func,
        Longtail_BlockStore_PutStoredBlockFunc* put_stored_block_func,
        Longtail_BlockStore_PreflightGetFunc* preflight_get_func,
        Longtail_BlockStore_GetStoredBlockFunc* get_stored_block_func,
        Longtail_BlockStore_GetExistingContentFunc* get_existing_content_func,
        Longtail_BlockStore_PruneBlocksFunc* prune_blocks_func,
        Longtail_BlockStore_GetStatsFunc* get_stats_func,
        Longtail_BlockStore_FlushFunc* flush_func)`,
    );

    this.Alloc = this.lib.func(
      "void* Longtail_Alloc(const char* context, size_t s)",
    );
    this.Free = this.lib.func("void Longtail_Free(void* p)");

    this.CreateCompressBlockStoreAPI = this.lib.func(
      `Longtail_BlockStoreAPI* Longtail_CreateCompressBlockStoreAPI(
        Longtail_BlockStoreAPI* backing_block_store,
        Longtail_CompressionRegistryAPI* compression_registry)`,
    );

    this.CreateLRUBlockStoreAPI = this.lib.func(
      `Longtail_BlockStoreAPI* Longtail_CreateLRUBlockStoreAPI(
        Longtail_BlockStoreAPI* backing_block_store,
        uint32_t max_lru_count)`,
    );

    this.CreateShareBlockStoreAPI = this.lib.func(
      `Longtail_BlockStoreAPI* Longtail_CreateShareBlockStoreAPI(
        Longtail_BlockStoreAPI* backing_block_store)`,
    );

    koffi.struct("Longtail_VersionDiff", {
      m_SourceRemovedCount: "uint32_t*",
      m_TargetAddedCount: "uint32_t*",
      m_ModifiedContentCount: "uint32_t*",
      m_ModifiedPermissionsCount: "uint32_t*",
      m_SourceRemovedAssetIndexes: "uint32_t*",
      m_TargetAddedAssetIndexes: "uint32_t*",
      m_SourceContentModifiedAssetIndexes: "uint32_t*",
      m_TargetContentModifiedAssetIndexes: "uint32_t*",
      m_SourcePermissionsModifiedAssetIndexes: "uint32_t*",
      m_TargetPermissionsModifiedAssetIndexes: "uint32_t*",
    });

    this.CreateVersionDiff = this.lib.func(
      `int Longtail_CreateVersionDiff(
        Longtail_HashAPI* hash_api,
        const Longtail_VersionIndex* source_version,
        const Longtail_VersionIndex* target_version,
        _Out_ Longtail_VersionDiff** out_version_diff)`,
    );

    this.GetRequiredChunkHashes = this.lib.func(
      `int Longtail_GetRequiredChunkHashes(
        const Longtail_VersionIndex* version_index,
        const Longtail_VersionDiff* version_diff,
        _Out_ uint32_t* out_chunk_count,
        _Out_ TLongtail_Hash* out_chunk_hashes)`,
    );

    this.CreateVersionIndex = this.lib.func(
      `int Longtail_CreateVersionIndex(
        Longtail_StorageAPI* storage_api,
        Longtail_HashAPI* hash_api,
        void* chunker_api,
        Longtail_JobAPI* job_api,
        void* progress_api,
        void* optional_cancel_api,
        void* optional_cancel_token,
        const char* root_path,
        const void* file_infos,
        const uint32_t* optional_asset_tags,
        uint32_t target_chunk_size,
        int enable_file_map,
        _Out_ Longtail_VersionIndex** out_version_index)`,
    );

    this.CreateHPCDCChunkerAPI = this.lib.func(
      `void* Longtail_CreateHPCDCChunkerAPI()`,
    );

    this.ChangeVersion = this.lib.func(
      `int Longtail_ChangeVersion(
        Longtail_BlockStoreAPI* block_store_api,
        Longtail_StorageAPI* version_storage_api,
        Longtail_HashAPI* hash_api,
        Longtail_JobAPI* job_api,
        Longtail_ProgressAPI* progress_api,
        Longtail_CancelAPI* optional_cancel_api,
        Longtail_CancelAPI_HCancelToken optional_cancel_token,
        const Longtail_StoreIndex* store_index,
        const Longtail_VersionIndex* source_version,
        const Longtail_VersionIndex* target_version,
        const Longtail_VersionDiff* version_diff,
        const char* version_path,
        int retain_permissions)`,
    );
  }

  public static get(): Longtail {
    if (!Longtail.instance) {
      Longtail.instance = new Longtail();
    }

    return Longtail.instance;
  }
}
