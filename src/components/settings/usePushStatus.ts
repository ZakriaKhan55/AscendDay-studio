import { useCallback, useRef, useState } from 'react';
import { getPushStatus, type PushStatus } from '@/lib/app/push';

/**
 * The Settings push switch's state. Reads of the device's push state can finish in any order (a tab
 * return, an account change, the read after a failed toggle), so only the newest read is shown, and
 * a value set by the toggle itself drops every read started before it (a read begun before turning
 * push on must not flip the switch back to off). `read` is replaceable for tests.
 */
export function usePushStatus(userId: string | undefined, read: (userId?: string) => Promise<PushStatus> = getPushStatus) {
  const [pushStatus, setStatus] = useState<PushStatus>('off');
  const latestRef = useRef(0);

  /** Reads the device's push state; on a failed read shows `onError` when given. */
  const readPushStatus = useCallback(
    (onError?: PushStatus) => {
      const seq = ++latestRef.current;
      read(userId).then(
        (status) => {
          if (seq === latestRef.current) setStatus(status);
        },
        () => {
          if (onError !== undefined && seq === latestRef.current) setStatus(onError);
        }
      );
    },
    [userId, read]
  );

  /** A value the toggle knows (it just changed push): newer than any read still on its way. */
  const setPushStatus = useCallback((status: PushStatus) => {
    latestRef.current++;
    setStatus(status);
  }, []);

  return { pushStatus, setPushStatus, readPushStatus };
}
