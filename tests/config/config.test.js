import { describe, it, expect, vi } from 'vitest';

// Set env vars in vi.hoisted so they run before imports are resolved
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.PORT = '4000';
  process.env.REDIS_URLS = 'redis://localhost:6379';
  process.env.GEMINI_KEYS = 'key1,key2';
  process.env.DEFAULT_MODEL = 'test-model';
  process.env.OWNER_EMAIL = 'owner@test.com';
});

// Mock dotenv/config to prevent .env file from overriding test env vars
vi.mock('dotenv/config', () => ({}));

import { config } from '../../src/config.js';

describe('config', () => {
  it('should parse PORT from env', () => {
    expect(config.port).toBe(4000);
  });

  it('should parse redisUrls from REDIS_URLS', () => {
    expect(config.redisUrls).toContain('redis://localhost:6379');
  });

  it('should parse geminiKeys from GEMINI_KEYS', () => {
    expect(config.geminiKeys).toContain('key1');
    expect(config.geminiKeys).toContain('key2');
  });

  it('should set defaultModel from env', () => {
    expect(config.defaultModel).toBe('test-model');
  });

  it('should set ownerEmail from env', () => {
    expect(config.ownerEmail).toBe('owner@test.com');
  });

  it('should set jwtSecret from env', () => {
    expect(config.jwtSecret).toBe('test-jwt-secret');
  });

  it('should have default cooldownMs', () => {
    expect(config.cooldownMs).toBeGreaterThan(0);
  });

  it('should have default maxRetries', () => {
    expect(config.maxRetries).toBeGreaterThan(0);
  });
});
