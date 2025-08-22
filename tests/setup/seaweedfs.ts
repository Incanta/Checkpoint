import { execSync } from 'child_process';

export async function setupSeaweedFS(): Promise<void> {
  console.log('Setting up SeaweedFS test environment...');
  
  try {
    // Check if Docker is available
    execSync('docker --version', { stdio: 'pipe' });
    
    // Stop any existing test containers
    try {
      execSync('docker-compose -f docker-compose.test.yaml down -v', { stdio: 'pipe' });
    } catch (error) {
      // Ignore errors if containers don't exist
    }
    
    // Start test containers
    execSync('docker-compose -f docker-compose.test.yaml up -d', { stdio: 'pipe' });
    
    // Wait for services to be ready
    await waitForSeaweedFS();
    
    console.log('SeaweedFS test environment ready');
  } catch (error) {
    console.error('Failed to setup SeaweedFS:', error);
    throw error;
  }
}

export async function cleanupSeaweedFS(): Promise<void> {
  console.log('Cleaning up SeaweedFS test environment...');
  
  try {
    execSync('docker-compose -f docker-compose.test.yaml down -v', { stdio: 'pipe' });
    console.log('SeaweedFS test environment cleanup complete');
  } catch (error) {
    console.error('Failed to cleanup SeaweedFS:', error);
    // Don't throw here as this is cleanup
  }
}

async function waitForSeaweedFS(): Promise<void> {
  const maxAttempts = 30;
  const delay = 2000; // 2 seconds
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Check if master is responding
      await fetch('http://localhost:19333/cluster/status');
      console.log('SeaweedFS master is ready');
      
      // Wait a bit more for filer to be ready
      await new Promise(resolve => setTimeout(resolve, 5000));
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`SeaweedFS not ready after ${maxAttempts} attempts`);
      }
      console.log(`Waiting for SeaweedFS... (attempt ${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}