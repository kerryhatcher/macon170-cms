# Pack 170 CMS

The isolated content-management backend for Pack 170. It runs as the `macon170-cms` Cloudflare Worker at `https://cms.macon170.com` and owns its own D1 database (`macon170-cms`) and R2 media bucket (`macon170-cms-media`). It has no binding to, and makes no changes to, the public site's Worker or database.

Its first collection is **Volunteer leadership roster**. Each record is a role; names may be blank for vacant roles. Publish only the records approved for display.

## Getting Started

### Prerequisites

- Node.js 18 or higher
- A Cloudflare account (free tier works great)
- Wrangler CLI (installed with dependencies)
- [pii-hound v0.1.9](https://github.com/saddledata/pii-hound/releases/tag/v0.1.9)
  on your `PATH`. Download the binary for your platform from that release and
  verify it against the published `checksums.txt` before installing it. The
  installed pre-commit hook scans changed files and blocks commits containing
  detected PII or secrets.

### Installation

1. **Install dependencies:**
   ```bash
   bun install --frozen-lockfile
   ```

2. **Create the CMS D1 database:**
   ```bash
   npx wrangler d1 create macon170-cms
   ```

   Copy the returned `database_id` into `wrangler.jsonc`.

3. **Create your R2 bucket:**
   ```bash
   npx wrangler r2 bucket create macon170-cms-media
   ```

4. **Run migrations:**
   ```bash
   bun run db:migrate:local
   ```

5. **Configure local-only environment variables:**
   ```bash
   cp .dev.vars.example .dev.vars
   ```

   Replace `JWT_SECRET` in the ignored `.dev.vars` file with a unique local secret. The default
   CORS origins permit the Astro dev server on this computer and the LAN hostname:
   ```dotenv
   CORS_ORIGINS=http://localhost:41771,http://kudzu:41771
   ```
   The committed Worker configuration permits only `https://www.macon170.com` in production.

6. **Start the development server:**
   ```bash
   just run
   ```

   In a second terminal, add the current roster to the local D1 database:
   ```bash
   bun run db:seed:local
   ```

7. **Open your browser:**
   Navigate to `http://kudzu:41772/admin` from any computer on the LAN to access the admin interface.

## Project Structure

```
cms/
├── src/
│   ├── collections/          # Your content type definitions
│   │   └── leadership-roster.collection.ts
│   └── index.ts             # Application entry point
├── wrangler.jsonc           # Cloudflare Worker configuration
├── package.json
└── tsconfig.json
```

## Available Scripts

- `bun run dev` - Start development server
- `bun run deploy` - Deploy to Cloudflare
- `bun run db:migrate` - Run migrations on production database
- `bun run db:migrate:local` - Run migrations locally
- `bun run type-check` - Check TypeScript types
- `bun run test` - Run tests

## Admin access

SonicJS owns its user accounts in the CMS D1 database. The public registration and SonicJS development seed routes are disabled. Provision the initial administrator with a one-time, secret-backed operational procedure before inviting editors; never add a password or password hash to source control.

## Content API

The roster collection is served by SonicJS at `/api/content/leadership-roster`. Frontend integration is intentionally out of scope for this backend-only phase.

## Deployment

1. **Login to Cloudflare:**
   ```bash
   npx wrangler login
   ```

2. **Deploy the CMS Worker:**
   ```bash
   bun run deploy
   ```

3. **Run the CMS migrations on production:**
   ```bash
   bun run db:migrate

## Continuous delivery

GitHub Actions validates pull requests and deploys only pushes to `main`. Configure these `production` environment secrets before the first automated deployment:

- `CLOUDFLARE_API_TOKEN` — deployment token for the Pack 170 Cloudflare account
- `CLOUDFLARE_ACCOUNT_ID` — Pack 170 Cloudflare account ID

The production `JWT_SECRET` stays in the Worker as a Cloudflare secret; ordinary deployments preserve it and do not copy it into GitHub.
   ```

## Documentation

- [SonicJS Documentation](https://sonicjs.com)
- [Collection Configuration](https://sonicjs.com/collections)
- [Plugin Development](https://sonicjs.com/plugins)
- [API Reference](https://sonicjs.com/api)

## Support

- [GitHub Issues](https://github.com/lane711/sonicjs/issues)
- [Discord Community](https://discord.gg/8bMy6bv3sZ)
- [Documentation](https://sonicjs.com)

## License

MIT
