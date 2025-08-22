import { PrismaClient } from '../src/app/node_modules/@prisma/client';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

let prisma: PrismaClient;

export async function setupTestDatabase(): Promise<PrismaClient> {
  console.log('Setting up test database...');
  
  // Remove existing test database
  const testDbPath = path.join(process.cwd(), 'src/app/test.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  
  // Set environment variables for test
  process.env.DATABASE_URL = 'file:./test.db';
  process.env.NODE_ENV = 'test';
  
  try {
    // Generate Prisma client
    execSync('cd src/app && npx prisma generate', { stdio: 'pipe' });
    
    // Run migrations
    execSync('cd src/app && npx prisma db push', { stdio: 'pipe' });
    
    // Create Prisma client
    const { PrismaClient } = require('../src/app/node_modules/@prisma/client');
    prisma = new PrismaClient();
    
    console.log('Test database setup complete');
    return prisma;
  } catch (error) {
    console.error('Failed to setup test database:', error);
    throw error;
  }
}

export async function cleanupTestDatabase(): Promise<void> {
  console.log('Cleaning up test database...');
  
  if (prisma) {
    await prisma.$disconnect();
  }
  
  // Remove test database file
  const testDbPath = path.join(process.cwd(), 'src/app/test.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  
  console.log('Test database cleanup complete');
}

export function getTestPrismaClient(): PrismaClient {
  if (!prisma) {
    throw new Error('Test database not initialized. Call setupTestDatabase first.');
  }
  return prisma;
}