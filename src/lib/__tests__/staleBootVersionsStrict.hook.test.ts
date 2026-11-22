// Hook test: staleBootVersions.hook under React StrictMode (dev double effects), same story
// (harness/staleBoot.ts).
import { runStaleBoot } from './harness/staleBoot';

await runStaleBoot('staleBootVersionsStrict.hook (StrictMode: stale device copy does not roll back newer rows)', true);
