# Apply pending local migrations, then serve the CMS on the LAN.
run:
  bun run db:migrate:local
  bun run dev

install:
  bun install --frozen-lockfile

check:
  bun run type-check

test:
  bun run test
