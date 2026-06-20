import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { readStdin } from "./claude-code.js";

/**
 * Regression coverage for the hook stdin reader.
 *
 * The reader used to call `process.stdin.setEncoding("utf-8")` (which makes the
 * "data" events emit *strings*) and then `Buffer.concat(chunks)` (which requires
 * *Buffers*). Every piped hook invocation — the documented primary usage —
 * crashed with ERR_INVALID_ARG_TYPE. These tests pipe real bytes through the
 * reader so that regression can't return silently.
 */

const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;

function mockStdin(): PassThrough {
  const stream = new PassThrough();
  // readStdin checks isTTY to short-circuit; a piped stdin is not a TTY.
  Object.defineProperty(stream, "isTTY", { value: false });
  Object.defineProperty(process, "stdin", {
    value: stream,
    configurable: true,
  });
  return stream;
}

afterEach(() => {
  Object.defineProperty(process, "stdin", realStdin);
});

describe("readStdin", () => {
  it("decodes piped Buffer chunks into a string", async () => {
    const stream = mockStdin();
    const payload = JSON.stringify({ tool_name: "Bash", exit_code: 0 });

    const pending = readStdin();
    stream.write(Buffer.from(payload, "utf-8"));
    stream.end();

    expect(await pending).toBe(payload);
  });

  it("decodes a multibyte character split across two chunks", async () => {
    const stream = mockStdin();
    // "é" is 0xC3 0xA9 in UTF-8 — split it across two data events. Decoding
    // once after concat (not per chunk) is what keeps this correct.
    const full = Buffer.from("café", "utf-8");
    const split = full.length - 1;

    const pending = readStdin();
    stream.write(full.subarray(0, split));
    stream.write(full.subarray(split));
    stream.end();

    expect(await pending).toBe("café");
  });

  it("returns empty JSON for a TTY (no piped data)", async () => {
    const stream = new PassThrough();
    Object.defineProperty(stream, "isTTY", { value: true });
    Object.defineProperty(process, "stdin", {
      value: stream,
      configurable: true,
    });

    expect(await readStdin()).toBe("{}");
  });
});
