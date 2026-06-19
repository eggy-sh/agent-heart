import { InvalidArgumentError } from "commander";

/**
 * Strict integer option parser. Commander prints a clean error and exits on an
 * InvalidArgumentError, so a typo (e.g. `--tokens abc`) fails loudly instead of
 * silently becoming NaN and dropping the whole request server-side.
 */
export function parseIntArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new InvalidArgumentError("must be an integer");
  }
  return n;
}

/** Strict float option parser (see parseIntArg). */
export function parseFloatArg(value: string): number {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) {
    throw new InvalidArgumentError("must be a number");
  }
  return n;
}
