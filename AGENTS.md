# Agent instructions

- After cloning, run `npm run hooks` once: it turns on the commit and push hooks (`.githooks`).
  It is not a `prepare` script on purpose: the party site installs this package as a git dependency, and npm would run (and hold back with a warning) an install script there.
  Re-running `npx release-kit apply .` adds a `prepare` script and `.github/workflows/auto-merge.yml` back; take both out again.

<!-- release-kit -->
## Commits and releases

- Write every commit message as a Conventional Commit: `type(scope): subject`, with type one of feat, fix, perf, security, refactor, docs, test, build, ci, chore, style, revert. A hook and a CI check reject anything else; see RELEASING.md.
- Use `feat` and `fix` only for changes a user would notice: they become the release notes and the public build log.
- Write those subjects as patch notes, for users: what they can now do or what works better, not the file, library or test you touched. When the subject must stay technical, add a `Release-note: <plain sentence>` line to the body, or `Release-note: skip` for a change no user would notice.
- Don't bump versions, edit CHANGELOG.md or releases.json, or create tags by hand: `npm run release` does all of it.
- Land changes through pull requests: a pre-push hook blocks pushing straight to main or a release branch, force pushes and moving release tags. Don't get around it with `--no-verify` or `RELEASE_KIT_ALLOW_DIRECT_PUSH=1` (that is for emergencies the owner asks for, and a Direct push alarm reports it either way).
<!-- /release-kit -->
