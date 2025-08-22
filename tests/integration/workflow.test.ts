/**
 * Integration Test: User → Org → Repo → Commit Flow
 * 
 * This test validates the complete workflow:
 * 1. Create a user
 * 2. Create an organization
 * 3. Create a repository
 * 4. Make a commit to the repository
 * 
 * This test exercises the core functionality of the Checkpoint system
 * and validates that all components work together correctly.
 */

import { TestDataHelper } from '../utils/test-data-helper';
import { getTestPrismaClient } from '../setup/database';

describe('Integration: Complete User-Org-Repo-Commit Flow', () => {
  let testHelper: TestDataHelper;
  let prisma: ReturnType<typeof getTestPrismaClient>;

  beforeAll(async () => {
    prisma = getTestPrismaClient();
    testHelper = new TestDataHelper();
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await testHelper.cleanupTestData();
  });

  afterEach(async () => {
    // Clean up test data after each test
    await testHelper.cleanupTestData();
  });

  it('should complete the full workflow: create user → create org → create repo → make commit', async () => {
    // Step 1: Create a user
    console.log('Step 1: Creating test user...');
    const user = await testHelper.createTestUser({
      name: 'Integration Test User',
      username: 'integration_test_user',
      email: 'integration@test.com',
    });

    expect(user).toBeDefined();
    expect(user.id).toBeTruthy();
    expect(user.username).toBe('integration_test_user');
    expect(user.email).toBe('integration@test.com');

    // Verify user was created in database
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    expect(dbUser).toBeTruthy();
    expect(dbUser?.username).toBe('integration_test_user');

    // Step 2: Create an organization
    console.log('Step 2: Creating test organization...');
    const org = await testHelper.createTestOrg(user.id, {
      name: 'Integration Test Org',
    });

    expect(org).toBeDefined();
    expect(org.id).toBeTruthy();
    expect(org.name).toBe('Integration Test Org');

    // Verify org was created and user is an admin
    const dbOrg = await prisma.org.findUnique({
      where: { id: org.id },
      include: {
        users: true,
      },
    });
    expect(dbOrg).toBeTruthy();
    expect(dbOrg?.name).toBe('Integration Test Org');
    expect(dbOrg?.users).toHaveLength(1);
    expect(dbOrg?.users[0]?.userId).toBe(user.id);
    expect(dbOrg?.users[0]?.role).toBe('ADMIN');

    // Step 3: Create a repository
    console.log('Step 3: Creating test repository...');
    const repo = await testHelper.createTestRepo(org.id, user.id, {
      name: 'integration-test-repo',
    });

    expect(repo).toBeDefined();
    expect(repo.id).toBeTruthy();
    expect(repo.name).toBe('integration-test-repo');
    expect(repo.orgId).toBe(org.id);

    // Verify repo was created with main branch and initial changelist
    const dbRepo = await prisma.repo.findUnique({
      where: { id: repo.id },
      include: {
        branches: true,
        changelists: true,
      },
    });
    expect(dbRepo).toBeTruthy();
    expect(dbRepo?.name).toBe('integration-test-repo');
    expect(dbRepo?.orgId).toBe(org.id);
    
    // Should have main branch
    expect(dbRepo?.branches).toHaveLength(1);
    expect(dbRepo?.branches[0]?.name).toBe('main');
    expect(dbRepo?.branches[0]?.isDefault).toBe(true);
    expect(dbRepo?.branches[0]?.headNumber).toBe(0);
    
    // Should have initial changelist
    expect(dbRepo?.changelists).toHaveLength(1);
    expect(dbRepo?.changelists[0]?.number).toBe(0);
    expect(dbRepo?.changelists[0]?.message).toBe('Repo Creation');

    // Step 4: Make a commit to the repository
    console.log('Step 4: Creating test commit...');
    const commit = await testHelper.createTestChangelist(repo.id, user.id, {
      message: 'Add integration test file',
    });

    expect(commit).toBeDefined();
    expect(commit.id).toBeTruthy();
    expect(commit.number).toBe(1); // Should be next number after initial changelist
    expect(commit.message).toBe('Add integration test file');
    expect(commit.repoId).toBe(repo.id);

    // Verify commit was created and branch head was updated
    const dbCommit = await prisma.changelist.findUnique({
      where: { id: commit.id },
    });
    expect(dbCommit).toBeTruthy();
    expect(dbCommit?.number).toBe(1);
    expect(dbCommit?.message).toBe('Add integration test file');
    expect(dbCommit?.userId).toBe(user.id);

    // Verify branch head was updated
    const updatedBranch = await prisma.branch.findFirst({
      where: {
        repoId: repo.id,
        isDefault: true,
      },
    });
    expect(updatedBranch?.headNumber).toBe(1);

    // Final verification: Check complete state
    console.log('Step 5: Verifying final state...');
    const finalState = await prisma.repo.findUnique({
      where: { id: repo.id },
      include: {
        org: {
          include: {
            users: {
              include: {
                user: true,
              },
            },
          },
        },
        branches: true,
        changelists: {
          orderBy: { number: 'asc' },
        },
      },
    });

    expect(finalState).toBeTruthy();
    expect(finalState?.org.name).toBe('Integration Test Org');
    expect(finalState?.org.users[0]?.user.username).toBe('integration_test_user');
    expect(finalState?.changelists).toHaveLength(2); // Initial + our commit
    expect(finalState?.changelists[1]?.message).toBe('Add integration test file');
    expect(finalState?.branches[0]?.headNumber).toBe(1);

    console.log('✅ Integration test completed successfully!');
  }, 60000); // 60 second timeout for this comprehensive test

  it('should handle multiple commits in sequence', async () => {
    // Setup: Create user, org, and repo
    const user = await testHelper.createTestUser();
    const org = await testHelper.createTestOrg(user.id);
    const repo = await testHelper.createTestRepo(org.id, user.id);

    // Create multiple commits
    const commit1 = await testHelper.createTestChangelist(repo.id, user.id, {
      message: 'First commit',
    });
    
    const commit2 = await testHelper.createTestChangelist(repo.id, user.id, {
      message: 'Second commit',
    });
    
    const commit3 = await testHelper.createTestChangelist(repo.id, user.id, {
      message: 'Third commit',
    });

    // Verify commit numbers are sequential
    expect(commit1.number).toBe(1);
    expect(commit2.number).toBe(2);
    expect(commit3.number).toBe(3);

    // Verify branch head points to latest commit
    const branch = await prisma.branch.findFirst({
      where: {
        repoId: repo.id,
        isDefault: true,
      },
    });
    expect(branch?.headNumber).toBe(3);

    // Verify all commits exist
    const allCommits = await prisma.changelist.findMany({
      where: { repoId: repo.id },
      orderBy: { number: 'asc' },
    });
    expect(allCommits).toHaveLength(4); // Initial + 3 commits
    expect(allCommits.map(c => c.message)).toEqual([
      'Repo Creation',
      'First commit',
      'Second commit',
      'Third commit',
    ]);
  });

  it('should enforce unique constraints', async () => {
    const user1 = await testHelper.createTestUser({
      username: 'unique_user',
      email: 'unique@test.com',
    });

    // Should not be able to create another user with same username
    await expect(
      testHelper.createTestUser({
        username: 'unique_user',
        email: 'different@test.com',
      })
    ).rejects.toThrow();

    // Should not be able to create another user with same email
    await expect(
      testHelper.createTestUser({
        username: 'different_user',
        email: 'unique@test.com',
      })
    ).rejects.toThrow();

    const org = await testHelper.createTestOrg(user1.id, {
      name: 'unique_org',
    });

    // Should not be able to create another org with same name
    await expect(
      testHelper.createTestOrg(user1.id, {
        name: 'unique_org',
      })
    ).rejects.toThrow();

    const repo1 = await testHelper.createTestRepo(org.id, user1.id, {
      name: 'unique_repo',
    });

    // Should not be able to create another repo with same name in same org
    await expect(
      testHelper.createTestRepo(org.id, user1.id, {
        name: 'unique_repo',
      })
    ).rejects.toThrow();
  });
});