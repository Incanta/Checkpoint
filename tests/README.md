# Jest Integration Test Setup

This repository includes a comprehensive Jest test setup for integration testing across the monorepo components.

## Overview

The test setup includes:
- **Root-level Jest configuration** for consistent testing across all packages
- **Integration tests** that validate the complete user workflow
- **Docker integration** for SeaweedFS testing
- **Database isolation** using SQLite test databases
- **Automated cleanup** of test resources

## Test Structure

```
tests/
├── setup.ts                    # Global test setup
├── setup/
│   ├── database.ts             # Database setup and cleanup
│   └── seaweedfs.ts            # SeaweedFS Docker setup
├── utils/
│   └── test-data-helper.ts     # Test data creation utilities
└── integration/
    ├── workflow.test.ts        # Main integration test
    ├── seaweedfs.test.ts       # SeaweedFS integration
    └── core-client.test.ts     # Core client functionality
```

## Integration Test Workflow

The main integration test (`workflow.test.ts`) validates the complete user workflow:

1. **Create a user** - Tests user creation with proper validation
2. **Create an organization** - Tests org creation and user permissions
3. **Create a repository** - Tests repo creation with branches and initial changelist
4. **Make a commit** - Tests changelist creation and branch updates

## Running Tests

### Prerequisites

1. **Node.js and npm/yarn** installed
2. **Docker** (for SeaweedFS tests)
3. **Dependencies** installed in each package

### Quick Start

```bash
# Install dependencies
npm install

# Run all integration tests
npm run test:integration

# Run tests with Docker setup (full integration)
npm run test:full

# Run tests in watch mode
npm run test:watch
```

### Individual Test Commands

```bash
# Setup test environment
npm run test:setup

# Run specific test suites
npm test -- tests/integration/workflow.test.ts
npm test -- tests/integration/seaweedfs.test.ts

# Cleanup test environment
npm run test:teardown
```

## Docker Integration

The test setup includes a dedicated Docker Compose file (`docker-compose.test.yaml`) that provides:

- **SeaweedFS Master** on port 19333
- **SeaweedFS Volume** on port 18080  
- **SeaweedFS Filer** on port 18888
- **Redis** on port 16379

Services use different ports than development to avoid conflicts.

### Manual Docker Setup

```bash
# Start test services
docker-compose -f docker-compose.test.yaml up -d

# Check service status
docker-compose -f docker-compose.test.yaml ps

# View logs
docker-compose -f docker-compose.test.yaml logs

# Stop and cleanup
docker-compose -f docker-compose.test.yaml down -v
```

## Database Testing

The test setup uses SQLite for database testing:

- **Isolated test database** (`test.db`) created for each test run
- **Automatic schema migration** using Prisma
- **Complete cleanup** after each test
- **Fast test execution** with in-memory operations

### Test Database Commands

```bash
# Setup test database (from src/app)
cd src/app && npm run test:db:setup

# Cleanup test database
cd src/app && npm run test:db:cleanup
```

## Test Environment Variables

The following environment variables control test behavior:

- `NODE_ENV=test` - Enables test mode
- `DATABASE_URL=file:./test.db` - Test database location
- `DOCKER_AVAILABLE=true` - Enable Docker-dependent tests
- `CI=true` - Adjust behavior for CI environments

## Writing New Tests

### Integration Test Pattern

```typescript
import { TestDataHelper } from '../utils/test-data-helper';

describe('Your Integration Test', () => {
  let testHelper: TestDataHelper;

  beforeAll(async () => {
    testHelper = new TestDataHelper();
  });

  beforeEach(async () => {
    await testHelper.cleanupTestData();
  });

  afterEach(async () => {
    await testHelper.cleanupTestData();
  });

  it('should test your workflow', async () => {
    const user = await testHelper.createTestUser();
    const org = await testHelper.createTestOrg(user.id);
    // ... your test logic
  });
});
```

### Using Test Data Helper

The `TestDataHelper` class provides convenient methods for creating test data:

```typescript
// Create test user
const user = await testHelper.createTestUser({
  name: 'Test User',
  username: 'testuser',
  email: 'test@example.com'
});

// Create test organization
const org = await testHelper.createTestOrg(user.id, {
  name: 'Test Org'
});

// Create test repository
const repo = await testHelper.createTestRepo(org.id, user.id, {
  name: 'test-repo'
});

// Create test commit
const commit = await testHelper.createTestChangelist(repo.id, user.id, {
  message: 'Test commit'
});
```

## CI/CD Integration

The test setup is designed to work in CI/CD environments:

- **Graceful degradation** when Docker is not available
- **Fast execution** with parallel test suites
- **Comprehensive reporting** with detailed test output
- **Automatic cleanup** prevents resource leaks

### CI Environment Variables

```bash
NODE_ENV=test
DATABASE_URL=file:./test.db
DOCKER_AVAILABLE=true  # Set to false if Docker not available
```

## Troubleshooting

### Common Issues

1. **Database connection errors**
   - Ensure Prisma is properly configured
   - Check that test database is writable
   - Verify NODE_ENV=test is set

2. **SeaweedFS connection failures**
   - Check Docker is running
   - Verify ports are not in use
   - Wait for services to fully start

3. **Permission errors**
   - Ensure test database directory is writable
   - Check Docker permissions

### Debug Commands

```bash
# Check test environment
npm test -- --verbose

# Run single test with full output
npm test -- tests/integration/workflow.test.ts --verbose

# Check Docker services
docker-compose -f docker-compose.test.yaml ps
docker-compose -f docker-compose.test.yaml logs filer-test
```

## Best Practices

1. **Always cleanup test data** in beforeEach/afterEach
2. **Use unique test identifiers** to avoid conflicts
3. **Mock external dependencies** when possible
4. **Test error conditions** as well as success paths
5. **Keep tests independent** - no shared state between tests
6. **Use descriptive test names** that explain the scenario

## Extending the Test Suite

To add new test categories:

1. Create new test files in `tests/integration/`
2. Follow the established patterns for setup/cleanup
3. Use the TestDataHelper for consistent data creation
4. Add appropriate documentation
5. Update CI/CD pipelines if needed

## Performance Considerations

- Tests run with `maxWorkers: 1` to avoid database conflicts
- Each test has a 2-minute timeout for comprehensive operations
- Database operations use SQLite for speed
- Docker services are shared across test runs when possible