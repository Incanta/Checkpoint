/**
 * tRPC client for server-side usage 
 * This module provides a typed HTTP client for the tRPC API
 */

import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "~/server/api/root";

export type { AppRouter } from "~/server/api/root";

export interface TRPCClientConfig {
  url: string;
  headers?: Record<string, string>;
}

export function createTRPCHTTPClient(config: TRPCClientConfig) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchStreamLink({
        url: config.url,
        headers: config.headers,
        transformer: superjson,
      }),
    ],
  });
}

// For backwards compatibility with GraphQL client pattern
export class CheckpointTRPCClient {
  private client: ReturnType<typeof createTRPCHTTPClient>;
  
  constructor(config: TRPCClientConfig) {
    this.client = createTRPCHTTPClient(config);
  }

  async request<T = any>(procedure: string, input?: any): Promise<T> {
    const [router, method] = procedure.split('.');
    
    switch (router) {
      case 'user':
        switch (method) {
          case 'me':
            return this.client.user.me.query() as Promise<T>;
          case 'createUser':
            return this.client.user.createUser.mutate(input) as Promise<T>;
          case 'updateUser':
            return this.client.user.updateUser.mutate(input) as Promise<T>;
          default:
            throw new Error(`Unknown user method: ${method}`);
        }
      case 'org':
        switch (method) {
          case 'myOrgs':
            return this.client.org.myOrgs.query() as Promise<T>;
          case 'getOrg':
            return this.client.org.getOrg.query(input) as Promise<T>;
          case 'createOrg':
            return this.client.org.createOrg.mutate(input) as Promise<T>;
          case 'updateOrg':
            return this.client.org.updateOrg.mutate(input) as Promise<T>;
          case 'deleteOrg':
            return this.client.org.deleteOrg.mutate(input) as Promise<T>;
          default:
            throw new Error(`Unknown org method: ${method}`);
        }
      case 'repo':
        switch (method) {
          case 'getRepo':
            return this.client.repo.getRepo.query(input) as Promise<T>;
          case 'createRepo':
            return this.client.repo.createRepo.mutate(input) as Promise<T>;
          case 'updateRepo':
            return this.client.repo.updateRepo.mutate(input) as Promise<T>;
          case 'deleteRepo':
            return this.client.repo.deleteRepo.mutate(input) as Promise<T>;
          default:
            throw new Error(`Unknown repo method: ${method}`);
        }
      case 'storage':
        switch (method) {
          case 'getToken':
            return this.client.storage.getToken.query(input) as Promise<T>;
          default:
            throw new Error(`Unknown storage method: ${method}`);
        }
      case 'branch':
        switch (method) {
          case 'getBranch':
            return this.client.branch.getBranch.query(input) as Promise<T>;
          case 'createBranch':
            return this.client.branch.createBranch.mutate(input) as Promise<T>;
          default:
            throw new Error(`Unknown branch method: ${method}`);
        }
      case 'changelist':
        switch (method) {
          case 'getChangelists':
            return this.client.changelist.getChangelists.query(input) as Promise<T>;
          case 'createChangelist':
            return this.client.changelist.createChangelist.mutate(input) as Promise<T>;
          default:
            throw new Error(`Unknown changelist method: ${method}`);
        }
      default:
        throw new Error(`Unknown router: ${router}`);
    }
  }

  // Direct access to the typed client for more complex usage
  get trpc() {
    return this.client;
  }
}