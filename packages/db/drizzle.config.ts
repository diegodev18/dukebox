import { defineConfig } from 'drizzle-kit'

/**
 * The database URL is read from the environment, never committed. On a VPS it
 * comes from /etc/dukebox/config.toml via the server; here it comes from the
 * dev compose stack.
 */
const url = process.env.DUKEBOX_DATABASE_URL

if (!url) {
  throw new Error('DUKEBOX_DATABASE_URL is required to run drizzle-kit')
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
