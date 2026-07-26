#!/usr/bin/env node
import { runBridge } from './bridge.mjs';

runBridge({
  name: 'agy-acp',
  version: '1.0.0',
  invocation: (prompt) => ({ bin: 'agy', args: ['-p', prompt] }),
});
