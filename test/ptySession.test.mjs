/**
 * Reconstructing an answer from terminal output.
 *
 * A TUI redraws, so the answer arrives interleaved with spinner frames, cursor
 * moves and repeated lines. These tests pin the two ways that can go wrong:
 * leaving chrome in, and taking the agent's own words out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractAnswer, parseModelPicker, stripAnsi } from "../src/ptySession.js";

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

test("two-character escapes are removed", () => {
  // ESC M (reverse index) shows up mid-answer during a redraw.
  const raw = `before${ESC}Mafter`;
  assert.equal(stripAnsi(raw), "beforeafter");
});

test("fragments of animated words are dropped, real words are not", () => {
  // Redraws shred "Generating..." into pieces; a colour is not a piece of it.
  const raw = "enerat\nrating\nting..\nRed\nGreen\nBlue\nGemini 3.7 Flash · high";
  assert.equal(extractAnswer(raw, { fromWorkingMarker: false }), "Red\nGreen\nBlue");
});

const PICKER_SCREEN = [
  "Switch Model",
  "> Gemini 3.7 Flash             (current)",
  "  Gemini 3.6 Flash",
  "  Gemini 3.1 Pro",
  "  Claude Sonnet 4.6 (Thinking)",
  "  Effort  low          medium          high",
  " Faster responses, lighter reasoning",
].join("\r\n");

test("the model picker is read as a list and a cursor", () => {
  assert.deepEqual(parseModelPicker(PICKER_SCREEN), {
    items: [
      "Gemini 3.7 Flash",
      "Gemini 3.6 Flash",
      "Gemini 3.1 Pro",
      "Claude Sonnet 4.6 (Thinking)",
    ],
    cursor: 0,
  });
});

test("the cursor is found wherever it sits, and (current) is not a name", () => {
  const screen = PICKER_SCREEN.replace("> Gemini 3.7 Flash", "  Gemini 3.7 Flash").replace(
    "  Gemini 3.1 Pro",
    "> Gemini 3.1 Pro",
  );
  const picker = parseModelPicker(screen);
  assert.equal(picker.cursor, 2);
  assert.equal(picker.items[0], "Gemini 3.7 Flash");
});

test("nothing is claimed when the picker is not on screen", () => {
  assert.equal(parseModelPicker("? for shortcutsGemini 3.7 Flash \u00b7 high"), null);
});

test("the effort slider ends the list rather than joining it", () => {
  const picker = parseModelPicker(PICKER_SCREEN);
  assert.ok(!picker.items.some((item) => item.includes("Effort")));
  assert.ok(!picker.items.some((item) => item.includes("Faster responses")));
});
