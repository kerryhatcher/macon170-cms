# Local CMS development, available on the LAN at http://kudzu:41772.
run:
  bun run dev

install:
  bun install --frozen-lockfile

check:
  bun run type-check

test:
  bun run test
