#!/usr/bin/env node
import { runBridge } from './bridge.mjs';

runBridge({
  name: 'pi-acp',
  version: '1.0.0',
  invocation: (prompt) => ({ bin: 'pi', args: ['-p', prompt] }),
});
