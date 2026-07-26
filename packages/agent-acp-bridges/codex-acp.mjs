#!/usr/bin/env node
import { runBridge } from './bridge.mjs';

// --skip-git-repo-check: unit workdirs are often not git repos (worktree staging,
// council tempdirs); without it codex refuses to run and exits 0 with a refusal
// message. This does NOT touch approvals or sandboxing.
runBridge({
  name: 'codex-acp',
  version: '1.0.0',
  invocation: (prompt) => ({ bin: 'codex', args: ['exec', '--skip-git-repo-check', prompt] }),
});
