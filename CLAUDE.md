# Working rules for this repo

## Scope

- **"Review these changes" means report and stop.** Return findings; do not edit source,
  tests, mutations, todo.md or docs. Dave decides what to act on. (Nine review requests each
  became an edit round, and several fixes undid the previous round's work.)
- **A short approval covers only the named items.** "yes", "do 1", "do prag recs" authorise
  exactly the numbered items. "pragmatic engineer?" is a question, not authorisation.
  Anything else noticed goes in one line at the end of the reply.
- **Never commit, push, stage, branch, stash or open PRs.** Dave does all of that. Leave
  changes in the working tree and propose a commit message when asked.
- **Dave edits files while you work.** Files changing underneath you is normal; keep going.

## Writing in the repo

- **todo.md holds open items only, a few lines each:** what is wrong, how to close it.
  Reasoning longer than a paragraph goes in the reply, or in `docs/` if Dave asks.
- **Do not paste subagent or persona output into the repo as fact.** Summarise it in the
  reply with its source; only the conclusion Dave accepts goes into a doc.
- **A comment states the current contract and names the test that guards it.** Do not
  narrate the history of past bugs in comments; git history has it.

## Verification

- `npm test` and `npm run test:mutation` after any source change. Both are fast.
- `npm run test:integration` only when the change touches `fileWatcher.ts`,
  `stateManager.ts` or an integration test, and at most once per turn. CI runs it on every
  pull request. Check `cat /proc/sys/fs/inotify/max_user_instances` against usage before
  believing a mass failure (see the inotify memory).
- A fix lands with a test that fails on the code before it, and a mutation in
  `scripts/mutation-check.mjs`. Reasoned-but-not-run does not count.
- After a source change, rebuild and reinstall the vsix (`IR_ALLOW_DIRTY=1 npx vsce package`
  then `code --install-extension`), and say the window needs a reload.
