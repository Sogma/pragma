/** `task`, run one at a time: a call while it runs waits, and every call
 * that waited runs it once more when it ends, so whatever prompted a call is
 * seen by a run that started after it. */
export function oneAtATime(task: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const run = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void task().finally(() => {
      running = false;
      if (!again) return;
      again = false;
      run();
    });
  };
  return run;
}
