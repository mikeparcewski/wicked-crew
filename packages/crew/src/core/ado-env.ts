/**
 * (crew#1843) The daemon's raw Azure DevOps credential: a personal access token, or the service principal a header is
 * minted from (`deliver-credentials.ts` `ADO_PAT_ENV` / `ADO_SP_ENV`, spelled here so this leaf module imports nothing).
 * The in-process engine reads it from the daemon's own environment (its deliver lift mints a fetch header); among the
 * children crew starts, only the two that mint a header use it: the Azure DevOps helper (`deliver.ts`
 * `defaultAdoHelperExec`: clones, work-item reads, PR views) and the post-hoc deliver script. Every crew child's env
 * (`childEnvWithBootEstateDb`) drops it; those two ask for it back by name ({@link withAdoCredential}).
 */
export const ADO_RAW_ENV = ['AZURE_DEVOPS_EXT_PAT', 'CREW_ADO_TENANT_ID', 'CREW_ADO_CLIENT_ID', 'CREW_ADO_CLIENT_SECRET'] as const;

/** Whether `key` names one of {@link ADO_RAW_ENV}. Windows names are case-insensitive: a child there reads
 *  `Azure_Devops_Ext_Pat` as the same variable. */
function isAdoRawName(key: string, platform: NodeJS.Platform): boolean {
  return (ADO_RAW_ENV as readonly string[]).includes(platform === 'win32' ? key.toUpperCase() : key);
}

/** `env` without {@link ADO_RAW_ENV}. */
export function withoutAdoCredential(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) if (isAdoRawName(k, platform)) delete out[k];
  return out;
}

/**
 * `child` with the raw Azure DevOps credential `from` holds put back, and nothing else of `from`. Only the two children
 * that mint a header call it (a static test pins the list: tests/ado-child-env.test.ts).
 */
export function withAdoCredential(child: NodeJS.ProcessEnv, from: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...child };
  for (const [k, v] of Object.entries(from)) if (v !== undefined && isAdoRawName(k, platform)) out[k] = v;
  return out;
}
