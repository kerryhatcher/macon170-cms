# Apply pending local migrations, then serve the CMS on the LAN.
run: install dev-vars
  bun run db:migrate:local
  bun run dev

install:
  bun install --frozen-lockfile

dev-vars:
  test -f .dev.vars || cp .dev.vars.example .dev.vars

check:
  bun run type-check

test:
  bun run test
