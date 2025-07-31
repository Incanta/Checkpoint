# RedwoodJS to tRPC Migration

This document outlines the migration from RedwoodJS GraphQL to tRPC that has been completed.

## What Changed

### 🔄 API Layer
- **Replaced**: GraphQL schema and resolvers → tRPC routers and procedures
- **Preserved**: Prisma schema and database models (unchanged)
- **Added**: Type-safe API with end-to-end TypeScript support

### 🏗️ Architecture Changes

#### Before (RedwoodJS):
```
Web App → Apollo Client → GraphQL → RedwoodJS Services → Prisma → Database
```

#### After (tRPC):
```
Web App → tRPC Client → tRPC Procedures → Prisma → Database
```

### 📁 File Structure Changes

#### API (`src/app/api/src/`)
- ✅ **Added**: `routers/` - tRPC procedure definitions
- ✅ **Added**: `lib/trpc.ts` - tRPC setup and middleware
- ✅ **Added**: `functions/trpc.ts` - tRPC server handler
- ✅ **Added**: `server.ts` - Development server
- 🗃️ **Backed up**: `services.backup/` - Original GraphQL services
- 🗃️ **Backed up**: `graphql.backup/` - GraphQL schema files
- 🗃️ **Backed up**: `directives.backup/` - GraphQL directives

#### Web (`src/app/web/src/`)
- ✅ **Added**: `utils/trpc.ts` - tRPC client setup
- ✅ **Added**: `components/TRPCProvider.tsx` - React Query provider
- ✅ **Updated**: `App.tsx` - Replaced Apollo with tRPC
- ✅ **Updated**: All pages to use tRPC hooks instead of GraphQL

### 🔌 API Endpoints

All original functionality is preserved with tRPC procedures:

#### Users
- `users.me` - Get current user
- `users.list` - List all users  
- `users.byId` - Get user by ID
- `users.create` - Create user (test only)
- `users.update` - Update user
- Plus relation queries: `orgs`, `specificRepoRoles`, `fileCheckouts`, `changelists`

#### Organizations
- `orgs.myOrgs` - Get user's organizations (with repos)
- `orgs.byId` - Get organization details
- `orgs.create` - Create organization
- `orgs.update` - Update organization
- `orgs.delete` - Soft delete organization
- `orgs.restore` - Restore deleted organization

#### Repositories
- `repos.list` - List repositories in org
- `repos.byId` - Get repository details
- `repos.create` - Create repository (with initial changelist & branch)
- `repos.update` - Update repository
- `repos.delete` - Soft delete repository
- `repos.restore` - Restore deleted repository

#### Changelists
- `changelists.byId` - Get changelist details
- `changelists.list` - List changelists
- `changelists.create` - Create changelist with file modifications

#### Additional Services
- **Files**: `files.byId`, `files.list`
- **Branches**: `branches.list`, `branches.byId`, `branches.create`
- **File Checkouts**: `fileCheckouts.list`, `fileCheckouts.create`, `fileCheckouts.remove`
- **API Tokens**: `apiTokens.list`, `apiTokens.create`, `apiTokens.delete`
- **Workspaces**: `workspaces.list`, `workspaces.byId`, `workspaces.create`, `workspaces.delete`
- **Storage**: Placeholder for future implementation

### 🔐 Authentication & Authorization

- **Preserved**: SuperTokens authentication system
- **Enhanced**: Type-safe authentication middleware
- **Maintained**: All existing permission checks and access controls

### 🚀 Development Setup

#### New Scripts
```bash
# Start both API and web in development
yarn dev

# Start API server only
yarn dev:api

# Start web client only  
yarn dev:web

# Generate Prisma types
yarn gen:types
```

#### Server URLs
- **API Server**: http://localhost:8911
- **Web Client**: http://localhost:8910
- **tRPC Endpoint**: http://localhost:8911/api/trpc

### 📦 Dependencies

#### Added
- `@trpc/server` - tRPC server
- `@trpc/client` - tRPC client
- `@trpc/react-query` - React Query integration
- `@tanstack/react-query` - Query management
- `zod` - Runtime validation
- `tsx` - TypeScript execution
- `concurrently` - Run multiple processes

#### Removed
- `@redwoodjs/graphql-server` - GraphQL server
- Apollo Client dependencies (automatically managed)

### ✨ Benefits

1. **End-to-end Type Safety**: Full TypeScript support from client to server
2. **Better DX**: Auto-completion, refactoring, and error detection
3. **Smaller Bundle**: No GraphQL overhead
4. **Simpler Setup**: Less configuration required
5. **Performance**: Automatic batching and caching with React Query

### 🔧 Preserved Features

- ✅ Authentication with SuperTokens
- ✅ All business logic and data operations
- ✅ Database schema and migrations
- ✅ Permission system and access controls
- ✅ Form handling and validation
- ✅ Real-time updates through query invalidation

### 📝 Notes

- Original GraphQL files are backed up and can be restored if needed
- Prisma schema remains unchanged as requested
- All existing API functionality is available through tRPC
- Development server setup allows for independent API/web development