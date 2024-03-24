This repository is a monorepo with different license for the encompassing software. Licenses found in a subfolder supersede licenses in a parent folder.

For convenience, below are links to the various main licenses:

- [Checkpoint desktop application](./src/desktop/LICENSE)
  - MIT license
  - Forked from [desktop/desktop](https://github.com/desktop/desktop)
  - Dependencies that the upstream repository used have had their licenses maintained
- [Longtail incremental asset delivery library](./src/longtail/library/LICENSE.txt)
  - MIT license
  - Forked from [DanEngelbrecht/longtail](https://github.com/DanEngelbrecht/longtail)
- [Longtail Node.js Addon](./src/longtail/addon/LICENSE)
  - SSPL license
  - We have future plans to change this to an open source license once Checkpoint-specific logic has been entirely moved to the Checkpoint core
- [Checkpoint core](./src/core/LICENSE)
  - SSPL license
  - As a small startup, we are keeping the majority of Checkpoint code under the source-available SSPL license, which is a modified AGPLv3 license from MongoDB, Inc. You can read more about SSPL on [MongoDB's website](https://www.mongodb.com/legal/licensing/server-side-public-license).
  - The reason for using SSPL is to give us a chance to provide a managed hosting service for Checkpoint repositories without competing with larger service providers. This choice enables us to provide a source-available license in the first place; otherwise we would need to follow competing source control solutions by completely closing the source.
