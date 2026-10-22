export class McpTimeoutError extends Error {}

/** Rejects with `message` if `task` has not settled within `ms`. */
export async function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new McpTimeoutError(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves `undefined` if `task` has not settled within `ms`. */
export async function raceTimeout<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
