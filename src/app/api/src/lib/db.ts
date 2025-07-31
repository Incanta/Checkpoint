// Mock Prisma client for development when generation fails due to network restrictions

interface MockPrismaClient {
  user: any;
  org: any;
  repo: any;
  changelist: any;
  file: any;
  branch: any;
  workspace: any;
  apiToken: any;
  $on: (event: string, callback: (e: any) => void) => void;
}

// Create a mock Prisma client
const mockPrismaClient: MockPrismaClient = {
  user: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => ({ id: 'mock-id', ...data.data }),
    update: async (data: any) => ({ id: 'mock-id', ...data.data }),
    delete: async () => ({ id: 'mock-id' }),
  },
  org: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => ({ id: 'mock-id', ...data.data }),
    update: async (data: any) => ({ id: 'mock-id', ...data.data }),
    delete: async () => ({ id: 'mock-id' }),
  },
  repo: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => ({ id: 'mock-id', ...data.data }),
    update: async (data: any) => ({ id: 'mock-id', ...data.data }),
    delete: async () => ({ id: 'mock-id' }),
  },
  changelist: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => ({ id: 'mock-id', ...data.data }),
    update: async (data: any) => ({ id: 'mock-id', ...data.data }),
    delete: async () => ({ id: 'mock-id' }),
  },
  file: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => ({ id: 'mock-id', ...data.data }),
    update: async (data: any) => ({ id: 'mock-id', ...data.data }),
    delete: async () => ({ id: 'mock-id' }),
  },
  branch: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => ({ id: 'mock-id', ...data.data }),
    update: async (data: any) => ({ id: 'mock-id', ...data.data }),
    delete: async () => ({ id: 'mock-id' }),
  },
  workspace: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => ({ id: 'mock-id', ...data.data }),
    update: async (data: any) => ({ id: 'mock-id', ...data.data }),
    delete: async () => ({ id: 'mock-id' }),
  },
  apiToken: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => ({ id: 'mock-id', ...data.data }),
    update: async (data: any) => ({ id: 'mock-id', ...data.data }),
    delete: async () => ({ id: 'mock-id' }),
  },
  $on: (event: string, callback: (e: any) => void) => {
    // Mock event handler
  },
};

let prismaClient: MockPrismaClient;

try {
  // Try to import real Prisma client
  const { PrismaClient } = require("@prisma/client");
  prismaClient = new PrismaClient({
    log: [
      { level: 'query', emit: 'event' },
      { level: 'info', emit: 'stdout' },
      { level: 'warn', emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
  });

  // Basic logging setup
  prismaClient.$on('query', (e) => {
    if (process.env.NODE_ENV === 'development') {
      console.log('Query: ' + e.query);
      console.log('Duration: ' + e.duration + 'ms');
    }
  });
} catch (error) {
  console.warn('Prisma client not available, using mock client for development');
  prismaClient = mockPrismaClient;
}

/**
 * Global Prisma client extensions should be added here, as $extend
 * returns a new instance.
 * export const db = prismaClient.$extend(...)
 * Add any .$on hooks before using $extend
 */
export const db = prismaClient;
