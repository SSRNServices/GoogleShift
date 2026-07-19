export function pLimit(concurrency: number) {
  const queue: (() => void)[] = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()!();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        activeCount++;
        fn().then(resolve, reject).finally(next);
      };

      if (activeCount < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}
