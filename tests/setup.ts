// Global test setup
import { setupTestDatabase, cleanupTestDatabase } from './setup/database';
import { setupSeaweedFS, cleanupSeaweedFS } from './setup/seaweedfs';

// Set test environment
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:./test.db';

// Setup and cleanup functions
beforeAll(async () => {
  console.log('Setting up test environment...');
  
  // Setup test database
  await setupTestDatabase();
  
  // Setup SeaweedFS (only if not running in CI without Docker)
  if (!process.env.CI || process.env.DOCKER_AVAILABLE) {
    await setupSeaweedFS();
  }
}, 60000);

afterAll(async () => {
  console.log('Cleaning up test environment...');
  
  // Cleanup SeaweedFS
  if (!process.env.CI || process.env.DOCKER_AVAILABLE) {
    await cleanupSeaweedFS();
  }
  
  // Cleanup test database
  await cleanupTestDatabase();
}, 30000);

// Increase timeout for integration tests
jest.setTimeout(120000);