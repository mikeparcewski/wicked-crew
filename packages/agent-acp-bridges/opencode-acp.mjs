#!/usr/bin/env node
import { runBridge } from './bridge.mjs';

runBridge({
  name: 'opencode-acp',
  version: '1.0.0',
  invocation: (prompt) => ({ bin: 'opencode', args: ['run', prompt] }),
});
