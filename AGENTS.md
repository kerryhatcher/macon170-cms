# macon170-cms agent guidance

This is the isolated SonicJS CMS Worker for Pack 170. Follow the workspace
guidance in `../AGENTS.md` and this project's `README.md`.

## Worktrees

Place Git worktrees in the workspace-level `../worktrees/` directory, not in
this project directory. For example, from the workspace root:

```bash
git -C macon170-cms worktree add ../worktrees/<branch-name> <branch-name>
```

## Commits

Commit focused, validated changes often. Use Conventional Commit messages in
the form `type(optional-scope): description`, such as
`docs(agents): add worktree guidance`. Use `feat` for new features and `fix`
for bug fixes; indicate breaking changes with `!` before the colon or an
uppercase `BREAKING CHANGE:` footer.

After installing dependencies in a fresh checkout, run `pre-commit install`.
Confirm it has installed the configured `pre-commit`, `commit-msg`, and
`pre-push` hooks before making commits or pushes.

## GitHub Actions

When adding or updating a GitHub Actions workflow, pin every third-party
action to its immutable full commit SHA; never use a mutable tag or branch.
Add a comment identifying the human-readable release version where useful.
