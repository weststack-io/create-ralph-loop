/**
 * Tiny zero-dependency console logger with ANSI colors. Honors NO_COLOR and
 * non-TTY output. Kept dependency-free on purpose (the old package shipped an
 * unused chalk dep).
 */

const useColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY ?? false);

function paint(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const color = {
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
  red: (s: string) => paint("31", s),
  green: (s: string) => paint("32", s),
  yellow: (s: string) => paint("33", s),
  blue: (s: string) => paint("34", s),
  cyan: (s: string) => paint("36", s),
  magenta: (s: string) => paint("35", s),
};

export const log = {
  info: (msg: string) => console.log(msg),
  step: (msg: string) => console.log(color.cyan("▸ ") + msg),
  success: (msg: string) => console.log(color.green("✓ ") + msg),
  warn: (msg: string) => console.warn(color.yellow("! ") + msg),
  error: (msg: string) => console.error(color.red("✗ ") + msg),
  dim: (msg: string) => console.log(color.dim(msg)),
  /** Raw passthrough (e.g. streaming agent output). */
  raw: (msg: string) => process.stdout.write(msg),
};
