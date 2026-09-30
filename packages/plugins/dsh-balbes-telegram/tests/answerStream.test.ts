import { describe, expect, it } from "vitest";
import {
  ANSWER_VIEW_LIMIT,
  LIVE_ANSWER_LIMIT,
  answerView,
  createLiveAnswer
} from "../src/answerStream.js";

/** Кадр-дельта текста, как его публикует движок. */
function textDelta(text: string): { type: string; chunk: { type: string; text: string } } {
  return { type: "chunk", chunk: { type: "text-delta", text } };
}

describe("live answer buffer", () => {
  it("accumulates text deltas of an open turn only", () => {
    const live = createLiveAnswer();
    // До открытия окна кадры не принимаются: живой текст принадлежит ходу.
    live.accept(textDelta("мусор"));
    expect(live.text()).toBe("");

    live.startTurn();
    live.accept(textDelta("пол"));
    live.accept(textDelta("ный ответ"));
    expect(live.text()).toBe("полный ответ");
  });

  it("ignores every frame that is not a text delta", () => {
    const live = createLiveAnswer();
    live.startTurn();
    live.accept({ type: "start" });
    live.accept({ type: "end" });
    live.accept({ type: "chunk", chunk: { type: "reasoning-delta", text: "рассуждение" } });
    live.accept({ type: "chunk", chunk: { type: "tool-call-delta", text: "аргументы" } });
    live.accept({ type: "chunk", chunk: { type: "block-start" } });
    live.accept({ type: "chunk", chunk: { type: "block-end", text: "блок" } });
    live.accept({ type: "chunk", chunk: { type: "usage", text: "1" } });
    live.accept({ type: "chunk", chunk: { type: "finish", text: "stop" } });
    live.accept({ type: "chunk" });
    live.accept(textDelta("только это"));
    expect(live.text()).toBe("только это");
  });

  it("clears the text when a turn opens and when it closes", () => {
    const live = createLiveAnswer();
    live.startTurn();
    live.accept(textDelta("первый ход"));
    live.endTurn();
    expect(live.text()).toBe("");
    // Закрытое окно молчит, даже если кадр придёт позже (осевший ход).
    live.accept(textDelta("поздно"));
    expect(live.text()).toBe("");

    live.startTurn();
    expect(live.text()).toBe("");
    live.accept(textDelta("второй ход"));
    expect(live.text()).toBe("второй ход");
  });

  it("keeps only the tail of a long answer", () => {
    const live = createLiveAnswer();
    live.startTurn();
    live.accept(textDelta("a".repeat(LIVE_ANSWER_LIMIT)));
    live.accept(textDelta("b".repeat(1000)));
    const text = live.text();
    expect(text).toHaveLength(LIVE_ANSWER_LIMIT);
    expect(text.endsWith("b".repeat(1000))).toBe(true);
    expect(text.startsWith("a")).toBe(true);
  });
});

describe("answer view", () => {
  it("returns short text whole and cuts long text to its tail", () => {
    expect(answerView("короткий ответ")).toBe("короткий ответ");
    const head = "H".repeat(4000);
    const tail = "T".repeat(ANSWER_VIEW_LIMIT);
    const view = answerView(head + tail);
    expect(view).toHaveLength(ANSWER_VIEW_LIMIT);
    expect(view).toBe(tail);
  });

  it("honours an explicit limit and never returns a negative slice", () => {
    expect(answerView("abcdef", 2)).toBe("ef");
    expect(answerView("abcdef", 0)).toBe("");
    expect(answerView("abcdef", -5)).toBe("");
  });
});
