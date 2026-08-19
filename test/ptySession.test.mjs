/**
 * Reconstructing an answer from terminal output.
 *
 * A TUI redraws, so the answer arrives interleaved with spinner frames, cursor
 * moves and repeated lines. These tests pin the two ways that can go wrong:
 * leaving chrome in, and taking the agent's own words out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractAnswer, stripAnsi } from "../src/ptySession.js";

const ESC = String.fromCharCode(27);

test("escape sequences are removed", () => {
  const raw = `${ESC}[>4;2m${ESC}[=1;1uhello${ESC}[0 q`;
  assert.equal(stripAnsi(raw).trim(), "hello");
});

test("comparison operators in prose survive stripping", () => {
  // Matching bare bracket forms rather than the escape character eats these.
  const raw = `${ESC}[0mPONG is > 5 and x=1 and y<2`;
  assert.equal(stripAnsi(raw).trim(), "PONG is > 5 and x=1 and y<2");
});

test("terminal chrome is dropped from the answer", () => {
  const raw = [
    "────────────────────",
    "⣾  Generating...",
    ">",
    "  The answer is 42.",
    "└ Tip: Use /skills to browse and manage agent skills.",
    "? for shortcutsGemini 3.7 Flash · high",
  ].join("\r\n");
  assert.equal(extractAnswer(raw), "The answer is 42.");
});

test("lines repeated by redraws appear once", () => {
  const raw = "Result: ok\r\nResult: ok\r\nResult: ok\r\n";
  assert.equal(extractAnswer(raw), "Result: ok");
});

test("a multi-line answer keeps its order", () => {
  const raw = "First line\r\n⣽ \r\nSecond line\r\n────────\r\nThird line\r\n";
  assert.equal(extractAnswer(raw), "First line\nSecond line\nThird line");
});

test("nothing but chrome yields nothing, rather than noise", () => {
  const raw = "⣾ \r\n────────\r\n>\r\n? for shortcuts\r\n";
  assert.equal(extractAnswer(raw), "");
});
