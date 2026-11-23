/** Points PRAGMA_CONFIG_DIR at `dir`; the function returned puts back the value it had, set or not. */
export function pointConfigAt(dir: string): () => void {
  const before = process.env.PRAGMA_CONFIG_DIR;
  process.env.PRAGMA_CONFIG_DIR = dir;
  return () => {
    if (before === undefined) delete process.env.PRAGMA_CONFIG_DIR;
    else process.env.PRAGMA_CONFIG_DIR = before;
  };
}
