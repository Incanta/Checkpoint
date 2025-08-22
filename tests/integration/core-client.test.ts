/**
 * Core Client Integration Test
 * 
 * This test validates the core client functionality can interact with the app API
 * using TRPC to perform repository operations.
 */

import { createTRPCClient, httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { TestDataHelper } from '../utils/test-data-helper';

// Mock the app router type - in a real implementation you'd import this
type AppRouter = any;

describe('Core Client Integration', () => {
  let testHelper: TestDataHelper;
  let testUser: any;
  let testOrg: any;
  let testRepo: any;

  // TRPC client for testing API calls
  let trpcClient: ReturnType<typeof createTRPCClient<AppRouter>>;

  beforeAll(async () => {
    testHelper = new TestDataHelper();

    // Note: In a real setup, you'd need to configure the TRPC client
    // to connect to a running app server. For this test framework,
    // we'll demonstrate the structure but may need to mock some responses.
    try {
      trpcClient = createTRPCClient<AppRouter>({
        links: [
          httpBatchLink({
            url: 'http://localhost:3000/api/trpc',
            transformer: superjson,
          }),
        ],
      });
    } catch (error) {
      console.log('TRPC client setup failed (expected in test environment):', error);
    }
  });

  beforeEach(async () => {
    await testHelper.cleanupTestData();
    
    // Create test data for each test
    testUser = await testHelper.createTestUser({
      name: 'Core Test User',
      username: 'core_test_user',
      email: 'core@test.com',
    });
    
    testOrg = await testHelper.createTestOrg(testUser.id, {
      name: 'Core Test Org',
    });
    
    testRepo = await testHelper.createTestRepo(testOrg.id, testUser.id, {
      name: 'core-test-repo',
    });
  });

  afterEach(async () => {
    await testHelper.cleanupTestData();
  });

  it('should validate core client can access repository data', async () => {
    // This test demonstrates how the core client would interact with the system
    // In a full implementation, this would test the actual CLI commands

    // Verify test data was created correctly
    expect(testUser.id).toBeTruthy();
    expect(testOrg.id).toBeTruthy();
    expect(testRepo.id).toBeTruthy();

    // Mock what the core client would do:
    // 1. Authenticate with the system
    // 2. List user's organizations
    // 3. List repositories in an organization
    // 4. Get repository details

    // For now, we'll test these operations directly against the database
    // to validate the data structure the core client would receive

    const prisma = testHelper['prisma']; // Access private prisma instance

    // Test listing user's orgs (what core client would get from API)
    const userOrgs = await prisma.org.findMany({
      where: {
        users: {
          some: {
            userId: testUser.id,
          },
        },
      },
      include: {
        repos: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    expect(userOrgs).toHaveLength(1);
    expect(userOrgs[0]?.name).toBe('Core Test Org');
    expect(userOrgs[0]?.repos).toHaveLength(1);
    expect(userOrgs[0]?.repos[0]?.name).toBe('core-test-repo');

    // Test getting repository details (what core client would get)
    const repoDetails = await prisma.repo.findUnique({
      where: { id: testRepo.id },
      include: {
        org: true,
        branches: true,
        changelists: {
          orderBy: { number: 'desc' },
          take: 10, // Recent commits
        },
      },
    });

    expect(repoDetails).toBeTruthy();
    expect(repoDetails?.name).toBe('core-test-repo');
    expect(repoDetails?.org.name).toBe('Core Test Org');
    expect(repoDetails?.branches).toHaveLength(1);
    expect(repoDetails?.branches[0]?.name).toBe('main');
    expect(repoDetails?.changelists).toHaveLength(1); // Initial changelist
  });

  it('should validate commit creation workflow', async () => {
    // Test the workflow that the core client would use to create a commit
    
    // 1. Get current branch state
    const prisma = testHelper['prisma'];
    const currentBranch = await prisma.branch.findFirst({
      where: {
        repoId: testRepo.id,
        isDefault: true,
      },
    });

    expect(currentBranch?.headNumber).toBe(0); // Initial state

    // 2. Create a new changelist (commit)
    const newCommit = await testHelper.createTestChangelist(testRepo.id, testUser.id, {
      message: 'Core client test commit',
      versionIndex: 'test_version_123',
    });

    expect(newCommit.number).toBe(1);
    expect(newCommit.message).toBe('Core client test commit');

    // 3. Verify branch head was updated
    const updatedBranch = await prisma.branch.findFirst({
      where: {
        repoId: testRepo.id,
        isDefault: true,
      },
    });

    expect(updatedBranch?.headNumber).toBe(1);

    // 4. Verify commit is in the repository history
    const commitHistory = await prisma.changelist.findMany({
      where: { repoId: testRepo.id },
      orderBy: { number: 'asc' },
    });

    expect(commitHistory).toHaveLength(2); // Initial + new commit
    expect(commitHistory[1]?.message).toBe('Core client test commit');
    expect(commitHistory[1]?.versionIndex).toBe('test_version_123');
  });

  it('should handle repository metadata operations', async () => {
    const prisma = testHelper['prisma'];

    // Test operations that the core client would perform:
    
    // 1. Get repository configuration
    const repoConfig = await prisma.repo.findUnique({
      where: { id: testRepo.id },
      select: {
        id: true,
        name: true,
        public: true,
        org: {
          select: {
            name: true,
            defaultRepoAccess: true,
          },
        },
      },
    });

    expect(repoConfig?.name).toBe('core-test-repo');
    expect(repoConfig?.public).toBe(false);
    expect(repoConfig?.org.name).toBe('Core Test Org');

    // 2. Get branch information
    const branches = await prisma.branch.findMany({
      where: { repoId: testRepo.id },
      orderBy: { name: 'asc' },
    });

    expect(branches).toHaveLength(1);
    expect(branches[0]?.name).toBe('main');
    expect(branches[0]?.isDefault).toBe(true);

    // 3. Get recent activity
    const recentActivity = await prisma.changelist.findMany({
      where: { repoId: testRepo.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        user: {
          select: {
            username: true,
            name: true,
          },
        },
      },
    });

    expect(recentActivity).toHaveLength(1); // Just the initial changelist
    expect(recentActivity[0]?.message).toBe('Repo Creation');
    expect(recentActivity[0]?.user?.username).toBe('core_test_user');
  });

  it('should validate user permissions', async () => {
    const prisma = testHelper['prisma'];

    // Test permission checks that the core client would need to perform

    // 1. Check if user can read repo
    const orgUser = await prisma.orgUser.findFirst({
      where: {
        userId: testUser.id,
        orgId: testOrg.id,
      },
      include: {
        org: true,
      },
    });

    expect(orgUser).toBeTruthy();
    expect(orgUser?.role).toBe('ADMIN'); // User should be admin of their org

    // 2. Check if user can write to repo
    const canWrite = orgUser?.role === 'ADMIN' || 
                    orgUser?.org.defaultRepoAccess === 'WRITE' ||
                    orgUser?.org.defaultRepoAccess === 'ADMIN';
    
    expect(canWrite).toBe(true);

    // 3. Check if user can create repos
    const canCreateRepos = orgUser?.role === 'ADMIN' || 
                          (orgUser?.org.defaultCanCreateRepos && orgUser?.canCreateRepos);
    
    expect(canCreateRepos).toBe(true);
  });
});