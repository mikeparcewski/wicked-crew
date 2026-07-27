#!/usr/bin/env node
import { runBridge } from './bridge.mjs';

// --add-dir scopes Antigravity's workspace to the session cwd. Without it, agy walks
// up from cwd to the nearest entry in its own trustedWorkspaces config (often $HOME or
// a projects root) and adopts THAT as the workspace — which is how a run-worktree cwd
// ended up writing into the main checkout (worktree-isolation breach, 2026-07-27).
// Residual risk: trustedWorkspaces ancestors may still win for some operations; the
// prompt-level worktree instruction remains the second layer.
runBridge({
  name: 'agy-acp',
  version: '1.0.0',
  invocation: (prompt, cwd) => ({ bin: 'agy', args: ['--add-dir', cwd, '-p', prompt] }),
});
