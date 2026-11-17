import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

export const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4003),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  SCYLLA_HOSTS: z.string().default('scylla:9042'),
  SCYLLA_KEYSPACE: z.string().default('zenuxs'),
  SCYLLA_DATACENTER: z.string().default('datacenter1'),
  REDIS_URL: z
    .string({
      required_error: 'REDIS_URL is required',
      invalid_type_error: 'REDIS_URL must be a string',
    })
    .min(1, 'REDIS_URL is required'),
  AUTH_JWKS_URL: z
    .string({
      required_error: 'AUTH_JWKS_URL is required',
      invalid_type_error: 'AUTH_JWKS_URL must be a string',
    })
    .url('AUTH_JWKS_URL must be a valid URL'),
  JWT_ISSUER: z.string().default('zenuxs-auth'),
  JWT_AUDIENCE: z.string().default('chat'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(envOverrides?: Record<string, unknown>): Config {
  const source = {
    ...process.env,
    ...envOverrides,
  };

  const result = configSchema.safeParse(source);
  if (!result.success) {
    const errorMessages = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration. Missing or invalid environment variables:\n${errorMessages}`
    );
  }

  return result.data;
}

let _configInstance: Config | null = null;

export const config: Config = new Proxy({} as Config, {
  get: (_target, prop: string | symbol) => {
    if (!_configInstance) {
      _configInstance = loadConfig();
    }
    return Reflect.get(_configInstance, prop);
  },
});
