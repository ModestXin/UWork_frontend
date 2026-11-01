import assert from "node:assert/strict";
import { test } from "node:test";
import { askUserQuestionToolEntry } from "../src/tool/handlers/ask-user-question.js";

const questions = [
  {
    question: "选择“环境”？",
    header: "环境",
    multiSelect: false,
    options: [
      { label: "甲", description: "甲" },
      { label: "乙", description: "乙" },
    ],
  },
  {
    question: "还有哪些输出？",
    header: "输出",
    multiSelect: true,
    options: [
      { label: "日志", description: "日志" },
      { label: "文件", description: "文件" },
    ],
  },
];
function present(
  answers: Record<string, string>,
  annotations?: Record<string, { preview?: string; notes?: string }>,
  inputQuestions = questions,
) {
  const format = askUserQuestionToolEntry.formatModelContent;
  assert.ok(format);
  const output = format({
    questions: inputQuestions,
    answers,
    ...(annotations ? { annotations } : {}),
  });
  assert.ok(typeof output === "string");
  return {
    output,
    value: JSON.parse(output) as {
      answers: Record<string, string>;
      guidance: string;
      annotations?: typeof annotations;
      questions?: unknown;
    },
  };
}
test("partial structured answers survive delimiters and Unicode without guessing", () => {
  const answers = { "选择“环境”？": '乙，保留 "quoted"\n第二行' };
  const { value } = present(answers);
  assert.deepEqual(value.answers, answers);
  assert.match(value.guidance, /skipped 1/);
  assert.match(value.guidance, /do not invent user preferences/);
});
test("empty answers are explicit continuation rather than rejection", () => {
  const { value } = present({});
  assert.deepEqual(value.answers, {});
  assert.match(value.guidance, /did not provide answers/);
  assert.match(value.guidance, /do not treat this as a rejection/);
});
test("all supplied answers and annotations round trip independently", () => {
  const answers = { "选择“环境”？": "乙", "还有哪些输出？": "日志, 文件" };
  const annotations = { "选择“环境”？": { preview: "line 1\nline 2", notes: "保持“原文”" } };
  const { value } = present(answers, annotations);
  assert.deepEqual(value.answers, answers);
  assert.deepEqual(value.annotations, annotations);
  assert.doesNotMatch(value.guidance, /skipped/);
});
test("presentation omits duplicated question definitions and unselected large previews", () => {
  const original = [
    {
      ...questions[0]!,
      options: questions[0]!.options.map((o) => ({
        ...o,
        preview: "unselected-preview-".repeat(10000),
      })),
    },
  ];
  const { value, output } = present({ "选择“环境”？": "乙" }, undefined, original);
  assert.equal(value.questions, undefined);
  assert.ok(output.length < 1000);
  assert.equal(output.includes("unselected-preview"), false);
});
