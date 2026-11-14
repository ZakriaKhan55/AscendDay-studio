import { useState, useCallback, useRef } from 'react';

export interface UseAsyncActionOptions<T = any> {
  onSuccess?: (result: T) => void;
  onError?: (error: Error) => void;
}

/**
 * Hook for managing single async action loading state. Loading lasts exactly as
 * long as the real work: no artificial minimum. Overlapping calls keep it on until
 * the last one ends.
 */
export function useAsyncAction<Args extends any[], ReturnType>(
  actionFn?: (...args: Args) => Promise<ReturnType>,
  options?: UseAsyncActionOptions<ReturnType>
) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pending = useRef(0);
  const start = useCallback(() => {
    pending.current += 1;
    setIsLoading(true);
  }, []);
  const finish = useCallback(() => {
    pending.current -= 1;
    if (pending.current === 0) setIsLoading(false);
  }, []);

  const execute = useCallback(
    async (...args: Args): Promise<ReturnType | undefined> => {
      start();
      setError(null);

      try {
        if (!actionFn) {
          throw new Error('No action function provided to useAsyncAction');
        }
        const result = await actionFn(...args);
        options?.onSuccess?.(result);
        return result;
      } catch (err: any) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        setError(errorObj);
        options?.onError?.(errorObj);
        throw err;
      } finally {
        finish();
      }
    },
    [actionFn, options, start, finish]
  );

  /**
   * Inline helper: execute an arbitrary inline async function
   */
  const executeFn = useCallback(
    async <T,>(inlineFn: () => Promise<T>): Promise<T | undefined> => {
      start();
      setError(null);

      try {
        const result = await inlineFn();
        return result;
      } catch (err: any) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        setError(errorObj);
        throw err;
      } finally {
        finish();
      }
    },
    [start, finish]
  );

  return {
    isLoading,
    error,
    execute,
    executeFn,
    setIsLoading,
    resetError: () => setError(null),
  };
}

/**
 * Hook for managing key-based async actions (e.g. actions on individual items in a list). A key
 * stays loading until its last overlapping call ends.
 */
export function useAsyncActionKey() {
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [errorMap, setErrorMap] = useState<Record<string, Error>>({});
  const pendingByKey = useRef(new Map<string, number>());

  const isKeyLoading = useCallback(
    (key: string) => loadingKeys.has(key),
    [loadingKeys]
  );

  const executeWithKey = useCallback(
    async <T,>(key: string, asyncFn: () => Promise<T>): Promise<T | undefined> => {
      pendingByKey.current.set(key, (pendingByKey.current.get(key) ?? 0) + 1);
      setLoadingKeys((prev) => new Set(prev).add(key));
      setErrorMap((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });

      try {
        const result = await asyncFn();
        return result;
      } catch (err: any) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        setErrorMap((prev) => ({ ...prev, [key]: errorObj }));
        throw err;
      } finally {
        const left = (pendingByKey.current.get(key) ?? 1) - 1;
        if (left > 0) {
          pendingByKey.current.set(key, left);
        } else {
          pendingByKey.current.delete(key);
          setLoadingKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
    },
    []
  );

  return {
    isKeyLoading,
    executeWithKey,
    hasAnyLoading: loadingKeys.size > 0,
    loadingKeys,
    errorMap,
  };
}
