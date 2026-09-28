# Working rules for this repo

## Scope

- **"Review these changes" means report and stop.** Return findings; do not edit source,
  tests, mutations, todo.md or docs. Dave decides what to act on.
- **A short approval covers only the named items.** "yes", "do 1", "do prag recs" authorise
  exactly the numbered items. "pragmatic engineer?" is a question, not authorisation.
  Anything else noticed goes in one line at the end of the reply.
- **Never commit, push, stage, branch, stash or open PRs.** Dave does all of that. Leave
  changes in the working tree and propose a commit message when asked.
- **Dave edits files while you work.** Files changing underneath you is normal; keep going.
  Mention it only if it breaks your work (an edit fails, or a script could clobber his).

## Building

- **IMPORTANT: no feature or multi-file change without an OpenSpec change.** Check
  `openspec/specs/` and `openspec/changes/` for an existing spec first. If there is none,
  create one with `/opsx:propose` (proposal, design, spec, tasks, with a Non-goals section)
  and get Dave's OK before any code; implement with `/opsx:apply`. A new change must not
  break the requirements in existing specs. If the ask changes mid-build, stop and update
  the change; do not patch the old design toward it. A one-line fix needs no spec.
- **Build the smallest thing that meets the ask.** No new layers, injection points, caches
  or defensive code for cases that cannot happen. A fix that removes code or restores what
  was there beats a new mechanism.
- **Before a source change, list what it touches and check each.** Editor buffers and save
  participants (formatOnSave, whitespace trimming, encoding), the watcher and self-edit
  marks, the git queue, reload vs memory, async timing, existing callers. Name what was
  checked and what was not. Read a line's comment before removing it.
- **Review findings are hypotheses, not facts.** Act on one only if it is a correctness bug
  against the spec in a scenario Dave will realistically hit, and a test reproduces it
  first. Races that need two actions within milliseconds, memory and performance are out of
  scope unless the spec says otherwise. When reporting, drop findings that fail this bar.
- **At most two review-and-fix rounds per change.** If a third round still finds real bugs,
  or a fix breaks something, stop patching: say so, and propose simplifying, cutting scope
  or reverting instead. After two failed corrections on the same thing, recommend a fresh
  session with a written spec.
- **Keep this file short.** A new rule replaces or tightens an old one; do not append.

## Writing in the repo

- **Never keep a rule or fact only in Claude's memory.** Working rules go in this file;
  reference material goes in `docs/`. Memory may point at them, never replace them.
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
  pull request. Before believing a failure, check it for inotify starvation as described in
  `docs/test-strategy.md` ("The integration suite on this machine").
- A fix lands with a test that fails on the code before it, and a mutation in
  `scripts/mutation-check.mjs`. Reasoned-but-not-run does not count, and green tests only
  prove the cases already thought of.
- **A user-visible feature is done only after it has been used end to end:** an integration
  test that drives the real flow, or Dave trying it in his window. Say which.
- After a source change, rebuild and reinstall the vsix (`IR_ALLOW_DIRTY=1 npx vsce package`
  then `code --install-extension <vsix> --force`), and say the window needs a reload. Check
  the install took: `~/.vscode/extensions/eccentricqualitysolutions.vsc-interactive-review-*/out/buildInfo.json`
  shows the commit, dirty flag and build time (the panel's settings screen shows the same).
- **When Dave reports extension behaviour, check which build is installed first**, from that
  `buildInfo.json`, before theorising about causes.
- When a change seems to warrant a new version (a user-visible fix or feature, or before a
  release or PR), ask whether to bump `version` in `package.json`, and suggest
  patch/minor/major. Do not bump it without a yes. The installed version stays the same
  otherwise, so `buildInfo.json` is the only way to tell builds apart.
