import { expect, test } from "bun:test";
import { formatSpan } from "../src/lib/span";

const H = 3_600_000;

test("formatSpan writes days and hours", () => {
  expect(formatSpan(52 * H)).toBe("2d 4h");
  expect(formatSpan(5 * H)).toBe("5h");
  expect(formatSpan(23 * H + 59 * 60_000)).toBe("23h");
  expect(formatSpan(24 * H)).toBe("1d");
  expect(formatSpan(48 * H)).toBe("2d");
  expect(formatSpan(30 * 24 * H + H)).toBe("30d 1h");
  expect(formatSpan(30 * 60_000)).toBe("<1h");
  expect(formatSpan(null)).toBe("—");
});
