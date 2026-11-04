// The image registry's describe generations (DES-APPS-001 §8.2, S14): an older describe that answers late never
// overwrites what a newer one saw, so a refusal is not undone by a stale probe, and a recovery is not undone by a
// stale failure.

import { describe, expect, it } from 'vitest';

import { ImageRegistry } from '../src/image.js';

const src = (name: string) => ({ config: { name, kind: 'rest' as const, command: null, args: [], url: 'https://api.example.com', auth: null }, tools: [{ name: 'listItems', schemaHash: 'h1' } as never], allowWrites: false });

describe('the image registry', () => {
  it('commits a describe only while it is the newest one started', async () => {
    const r = new ImageRegistry({ api: src('api') }, [{ name: 'api', env: null }]);
    const older = r.beginDescribe('api');
    const newer = r.beginDescribe('api');
    r.setObserved('api', new Map([['listItems', 'h2']]), newer); // the newer probe: the operation changed
    r.setObserved('api', new Map([['listItems', 'h1']]), older); // the older probe answers late: discarded
    expect((await r.appTool('api', 'listItems'))?.bound).toBe(false);
    const third = r.beginDescribe('api');
    r.setObserved('api', new Map([['listItems', 'h1']]), third); // back as published
    r.setDown('api', 'timeout', 0, newer); // a stale failure: discarded
    expect(r.downOf('api')).toBeNull();
    expect((await r.appTool('api', 'listItems'))?.bound).toBe(true);
  });

  it('a tool is bound only while the live schema equals the published one; a secret only from its own environment name', async () => {
    const r = new ImageRegistry({ api: src('api') }, [{ name: 'api', env: 'APPS_SRC_API_TOKEN' }], { APPS_SRC_API_TOKEN: 't0k' });
    expect((await r.appTool('api', 'listItems'))?.bound).toBe(false); // never probed
    r.setObserved('api', new Map([['listItems', 'h1']]));
    expect((await r.appTool('api', 'listItems'))?.bound).toBe(true);
    expect(await r.callSecret({ ...src('api').config, auth: { ref: 'keychain:wicked-mcp/api' } })).toEqual({ secret: 't0k', missing: false });
    const bare = new ImageRegistry({ api: src('api') }, [{ name: 'api', env: 'APPS_SRC_API_TOKEN' }], {});
    expect(await bare.callSecret({ ...src('api').config, auth: { ref: 'keychain:wicked-mcp/api' } })).toEqual({ secret: null, missing: true });
  });
});
