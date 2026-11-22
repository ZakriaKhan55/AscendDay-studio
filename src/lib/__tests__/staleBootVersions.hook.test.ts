// Hook test (real useAppState + in-process fake Supabase, see harness/): a cold boot from a device
// cache whose stored tab versions lag one save behind shows the other device's newer rows and
// uploads nothing over them; a real unsent edit still uploads. Story: harness/staleBoot.ts.
import { runStaleBoot } from './harness/staleBoot';

await runStaleBoot('staleBootVersions.hook (stale device copy does not roll back newer rows)', false);
