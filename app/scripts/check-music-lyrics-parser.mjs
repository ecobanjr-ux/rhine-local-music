// 阶段 5 T1 —— 歌词解析层单测。
// 用例移植自 folia-major（AGPL-3.0）test/unit/lyrics/parserCore.test.ts（427 行 / 25 个 it）中
// 本项目已移植格式可表达的部分：LRC、enhanced-LRC、VTT、TTML、工厂分派、formatDetection、
// splitCombinedTimeline。folia 未在本文件移植的 parseYRC / parseKRC / parseAwlrc 用例
// 一并省略（parseQRC 已于第四期 R56 移植，用例见文件末尾）。vitest 的 describe/it/expect
// 改写为 node:test 的 test() + node:assert/strict；
// 夹具内联为字符串（folia 原本也是内联字符串，不读外部文件）。
// 另新增安全预检用例：合法 <?xml?> 通过、含 <!DOCTYPE/<!ENTITY 拒绝（大写、小写、前置 BOM/空白）。

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectTimedLyricFormat,
  resolveExplicitFileTimedLyricFormat,
} from "../src/lyrics/format-detection.ts";
import { splitCombinedTimeline } from "../src/lyrics/timeline-splitter.ts";
import {
  findTranslationsForSortedStartTimes,
  parseEnhancedLRC,
  parseLRC,
  parseLyricsByFormat,
  parseTTML,
  parseVTT,
} from "../src/lyrics/parser-core.ts";
import { parseLyrics } from "../src/lyrics/index.ts";

const expectNonDecreasingWordTimes = (words) => {
  for (let index = 1; index < words.length; index += 1) {
    assert.ok(words[index].startTime >= words[index - 1].startTime);
    assert.ok(words[index].endTime >= words[index].startTime);
  }
};

const TTML_ADVANCED_FIXTURE = [
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:amll="http://www.example.com/ns/amll" itunes:timing="Word">',
  "<head><metadata>",
  '<ttm:agent type="person" xml:id="v1"><ttm:name>Alice</ttm:name></ttm:agent>',
  '<ttm:agent type="person" xml:id="v2"><ttm:name>Bob</ttm:name></ttm:agent>',
  '<amll:meta key="musicName" value="Ignored Song Title"/>',
  '<amll:meta key="artists" value="Ignored Artist"/>',
  "</metadata></head>",
  '<body dur="00:08.000">',
  '<div begin="00:01.000" end="00:08.000" itunes:songPart="Chorus">',
  '<p begin="00:01.000" end="00:05.000" itunes:key="L1" ttm:agent="v2">',
  '<span begin="00:01.000" end="00:01.400">hurri</span><span begin="00:01.400" end="00:02.000">cane</span> ',
  '<span tts:ruby="container" amll:empty-beat="2"><span tts:ruby="base">風</span><span tts:ruby="textContainer"><span tts:ruby="text" begin="00:02.000" end="00:02.500">かぜ</span></span></span>',
  '<span ttm:role="x-bg" begin="00:03.000" end="00:04.000"><span begin="00:03.000" end="00:03.500">echo</span><span begin="00:03.500" end="00:04.000">es</span><span ttm:role="x-translation" xml:lang="zh-CN">回声</span></span>',
  '<span ttm:role="x-translation" xml:lang="zh-CN">飓风之风</span>',
  '<span ttm:role="x-roman" xml:lang="en-Latn">hurricane kaze</span>',
  "</p>",
  "</div>",
  "</body>",
  "</tt>",
].join("");

const TTML_AGENT_OVERLAP_FIXTURE = [
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word">',
  "<body><div>",
  '<p begin="00:01.000" end="00:05.000" itunes:key="L1" ttm:agent="v1">',
  '<span begin="00:01.000" end="00:05.000">Main</span>',
  "</p>",
  '<p begin="00:02.000" end="00:06.000" itunes:key="L2" ttm:agent="v2">',
  '<span begin="00:02.000" end="00:06.000">Harmony</span>',
  '<span ttm:role="x-translation" xml:lang="zh-CN">和声翻译</span>',
  "</p>",
  '<p begin="00:06.000" end="00:08.000" itunes:key="L3" ttm:agent="v2">',
  '<span begin="00:06.000" end="00:08.000">Next</span>',
  "</p>",
  "</div></body>",
  "</tt>",
].join("");

// —— formatDetection ——
test("从支持的文件名解析显式歌词格式", () => {
  assert.equal(resolveExplicitFileTimedLyricFormat("song.vtt"), "vtt");
  assert.equal(resolveExplicitFileTimedLyricFormat("song.ttml"), "ttml");
  // 文件名识别仍保留 yrc/qrc/krc（本项目解析器未移植这些平台专有格式）。
  assert.equal(resolveExplicitFileTimedLyricFormat("song.qrc"), "qrc");
  assert.equal(resolveExplicitFileTimedLyricFormat("song.yrc"), "yrc");
  assert.equal(resolveExplicitFileTimedLyricFormat("song.krc"), "krc");
  assert.equal(resolveExplicitFileTimedLyricFormat("song.lrc"), undefined);
  assert.equal(resolveExplicitFileTimedLyricFormat("song.txt"), undefined);
});

// —— parseLRC ——
test("解析标准 LRC：翻译匹配与间奏插入", () => {
  const lyrics = parseLRC(
    "[00:04.00]Hello world\n[00:10.00]再见",
    "[00:04.20]你好 世界\n[00:10.10]Goodbye"
  );

  assert.equal(lyrics.lines.length, 3);
  assert.equal(lyrics.lines[0].fullText, "......");
  assert.equal(lyrics.lines[1].fullText, "Hello world");
  assert.equal(lyrics.lines[1].translation, "你好 世界");
  assert.equal(lyrics.lines[2].fullText, "再见");
  assert.equal(lyrics.lines[2].translation, "Goodbye");
  expectNonDecreasingWordTimes(lyrics.lines[1].words);
});

// —— parseEnhancedLRC ——
test("解析 enhanced LRC：元信息与逐字精确时间", () => {
  const lyrics = parseEnhancedLRC(
    "[ti:Song]\n[ar:Artist]\n[00:00.000]<00:00.000>你<00:00.300>好<00:00.600>!<00:00.900>",
    "[00:00.000]Hello"
  );

  assert.equal(lyrics.title, "Song");
  assert.equal(lyrics.artist, "Artist");
  assert.equal(lyrics.lines.length, 1);
  assert.equal(lyrics.lines[0].fullText, "你好!");
  assert.equal(lyrics.lines[0].translation, "Hello");
  assert.deepEqual(lyrics.lines[0].words.map((word) => word.text), ["你", "好", "!"]);
  assert.equal(lyrics.lines[0].words[0].startTime, 0);
  assert.equal(lyrics.lines[0].words[0].endTime, 0.3);
});

// —— parseVTT ——
test("解析 VTT 提示并剥离标记", () => {
  const lyrics = parseVTT(
    "WEBVTT\n\n00:00.000 --> 00:01.500\n<c.red>Hello&nbsp;&amp; hi</c>",
    "WEBVTT\n\n00:00.000 --> 00:01.500\n你好"
  );

  assert.equal(lyrics.lines.length, 1);
  assert.equal(lyrics.lines[0].fullText, "Hello & hi");
  assert.equal(lyrics.lines[0].translation, "你好");
  assert.equal(lyrics.lines[0].endTime, 1.5);
});

// —— parseTTML（环境自适应 DOMParser：Node 下回落 @xmldom/xmldom）——
test("解析 TTML 高级结构：不把歌曲元信息当作歌词标题", async () => {
  assert.equal(detectTimedLyricFormat(TTML_ADVANCED_FIXTURE), "ttml");

  const lyrics = await parseTTML(TTML_ADVANCED_FIXTURE);
  const line = lyrics.lines[0];

  assert.equal(lyrics.title, undefined);
  assert.equal(lyrics.artist, undefined);
  assert.equal(lyrics.isWordByWord, true);
  assert.equal(lyrics.ttml?.timingMode, "Word");
  assert.deepEqual(lyrics.ttml?.agents?.v2, { id: "v2", name: "Bob", type: "person" });

  assert.equal(line.id, "L1");
  assert.equal(line.agentId, "v2");
  assert.equal(line.songPart, "Chorus");
  assert.equal(line.isChorus, true);
  assert.equal(line.blockIndex, 1);
  assert.equal(line.fullText, "hurricane 風");
  assert.equal(line.translation, "飓风之风");
  assert.equal(line.romanization, "hurricane kaze");
  assert.deepEqual(line.alternateTexts, [
    { role: "translation", language: "zh-CN", text: "飓风之风" },
    { role: "romanization", language: "en-Latn", text: "hurricane kaze" },
  ]);

  assert.deepEqual(line.words.map((word) => word.text), ["hurricane", "風"]);
  assert.equal(line.words[0].startTime, 1);
  assert.equal(line.words[0].endTime, 2);
  assert.deepEqual(line.words[0].syllables?.map((syllable) => syllable.text), ["hurri", "cane"]);
  assert.equal(line.words[0].syllables?.[1].endsWithSpace, true);
  assert.deepEqual(line.words[1].syllables?.[0].ruby, [{ text: "かぜ", startTime: 2, endTime: 2.5 }]);
  assert.equal(line.words[1].syllables?.[0].emptyBeat, 2);

  assert.equal(line.backgroundVocal?.text, "echoes");
  assert.equal(line.backgroundVocal?.translation, "回声");
  assert.deepEqual(line.backgroundVocal?.words.map((word) => word.text), ["echoes"]);
  assert.deepEqual(line.backgroundVocals, [line.backgroundVocal]);
  assert.equal(lyrics.lines.length, 1);
});

test("把不同 agent 的重叠 TTML 行折叠为和声伴唱", async () => {
  const lyrics = await parseTTML(TTML_AGENT_OVERLAP_FIXTURE, "", { includeInterludes: false });

  assert.deepEqual(lyrics.lines.map((line) => line.fullText), ["Main", "Next"]);
  assert.equal(lyrics.lines[0].backgroundVocal?.text, "Harmony");
  assert.equal(lyrics.lines[0].backgroundVocal?.agentId, "v2");
  assert.equal(lyrics.lines[0].backgroundVocal?.translation, "和声翻译");
  assert.equal(lyrics.lines[0].backgroundVocal?.startTime, 2);
  assert.equal(lyrics.lines[0].backgroundVocal?.endTime, 6);
});

test("不折叠同一 agent 的重叠 TTML 行", async () => {
  const fixture = TTML_AGENT_OVERLAP_FIXTURE.replace(
    'itunes:key="L2" ttm:agent="v2"',
    'itunes:key="L2" ttm:agent="v1"'
  );
  const lyrics = await parseTTML(fixture, "", { includeInterludes: false });

  assert.deepEqual(lyrics.lines.map((line) => line.fullText), ["Main", "Harmony", "Next"]);
  assert.equal(lyrics.lines.every((line) => line.backgroundVocal === undefined), true);
});

test("不同 agent 仅在边界相接的 TTML 行不折叠", async () => {
  const fixture = TTML_AGENT_OVERLAP_FIXTURE.replace(
    'begin="00:02.000" end="00:06.000" itunes:key="L2"',
    'begin="00:05.000" end="00:06.000" itunes:key="L2"'
  ).replace(
    '<span begin="00:02.000" end="00:06.000">Harmony</span>',
    '<span begin="00:05.000" end="00:06.000">Harmony</span>'
  );
  const lyrics = await parseTTML(fixture, "", { includeInterludes: false });

  assert.deepEqual(lyrics.lines.map((line) => line.fullText), ["Main", "Harmony", "Next"]);
  assert.equal(lyrics.lines.every((line) => line.backgroundVocal === undefined), true);
});

// —— 工厂 parseLyricsByFormat（未移植 yrc/qrc/krc/awlrc，对应分派已删）——
test("parseLyricsByFormat 分派 enhanced-lrc", async () => {
  const lyrics = await parseLyricsByFormat(
    "enhanced-lrc",
    "[00:00.000]<00:00.000>A<00:00.500>B<00:01.000>",
    ""
  );

  assert.equal(lyrics.lines.length, 1);
  assert.deepEqual(lyrics.lines[0].words.map((word) => word.text), ["A", "B"]);
});

test("parseLyricsByFormat 分派 ttml", async () => {
  const lyrics = await parseLyricsByFormat("ttml", TTML_ADVANCED_FIXTURE);

  assert.equal(lyrics.lines[0].fullText, "hurricane 風");
  assert.equal(lyrics.lines[0].backgroundVocal?.text, "echoes");
});

// —— 排序与更多 LRC 语义 ——
test("乱序 LRC 输入经条件排序后保持解析语义", () => {
  const lyrics = parseLRC(
    "[00:10.00]Second\n[00:04.00]First",
    "[00:10.10]Deuxieme\n[00:04.20]Premier"
  );

  assert.equal(lyrics.lines.length, 3);
  assert.equal(lyrics.lines[0].fullText, "......");
  assert.equal(lyrics.lines[1].fullText, "First");
  assert.equal(lyrics.lines[1].translation, "Premier");
  assert.equal(lyrics.lines[2].fullText, "Second");
  assert.equal(lyrics.lines[2].translation, "Deuxieme");
});

test("解析 Hello/How are you 夹具中截取的普通 LRC 行", () => {
  const excerpt = [
    "[00:12.428]ハロ窓を開けて小さく呟いた",
    "[00:17.798]ハワユ誰もいない部屋で一人",
    "[00:22.266]モーニン朝が来たよ",
  ].join("\n");

  const lyrics = parseLRC(excerpt);

  assert.equal(lyrics.lines.length, 4);
  assert.equal(lyrics.lines[0].fullText, "......");
  assert.equal(lyrics.lines[1].fullText, "ハロ窓を開けて小さく呟いた");
  assert.equal(lyrics.lines[2].fullText, "ハワユ誰もいない部屋で一人");
  assert.equal(lyrics.lines[3].fullText, "モーニン朝が来たよ");
  assert.equal(lyrics.lines[1].translation, undefined);
  assert.ok(lyrics.lines[1].words.length > 5);
  expectNonDecreasingWordTimes(lyrics.lines[1].words);
});

// —— splitCombinedTimeline + 共享解析管线 ——
test("行级双语 LRC 在共享管线解析前拆分", async () => {
  const combinedExcerpt = [
    "[00:12.428]ハロ窓を開けて小さく呟いた",
    "[00:12.428]你好 打开窗户轻声说道",
    "[00:17.798]ハワユ誰もいない部屋で一人",
    "[00:17.798]你好吗 独自在空无一人的房间里",
    "[00:22.266]モーニン朝が来たよ",
    "[00:22.266]早上好 清晨来临",
  ].join("\n");

  const { main, trans } = splitCombinedTimeline(combinedExcerpt);
  const format = detectTimedLyricFormat(main);
  const lyrics = await parseLyricsByFormat(format, main, trans);

  assert.equal(format, "lrc");
  assert.ok(main.includes("[00:12.428]ハロ窓を開けて小さく呟いた"));
  assert.ok(!main.includes("你好 打开窗户轻声说道"));
  assert.ok(trans.includes("[00:12.428]你好 打开窗户轻声说道"));
  assert.equal(lyrics.lines.length, 4);
  assert.equal(lyrics.lines[0].fullText, "......");
  assert.equal(lyrics.lines[1].fullText, "ハロ窓を開けて小さく呟いた");
  assert.equal(lyrics.lines[1].translation, "你好 打开窗户轻声说道");
  assert.equal(lyrics.lines[2].fullText, "ハワユ誰もいない部屋で一人");
  assert.equal(lyrics.lines[2].translation, "你好吗 独自在空无一人的房间里");
});

test("解析 Hello/How are you 夹具中方括号定时的 enhanced LRC 片段", async () => {
  const combinedExcerpt = [
    "[00:12.428]ハ[00:12.667]ロ[00:13.343]窓[00:13.548]を[00:13.747]開[00:14.073]け[00:14.449]て[00:15.019]小[00:15.426]さ[00:15.637]く[00:15.794]呟[00:16.024]い[00:16.500]た[00:16.986]",
    "[00:12.428]你好 打开窗户轻声说道[00:16.986]",
    "[00:17.798]ハ[00:17.981]ワ[00:18.171]ユ[00:18.380]誰[00:18.528]も[00:18.801]い[00:19.060]な[00:19.463]い[00:20.056]部[00:20.282]屋[00:20.541]で[00:20.800]一[00:21.171]人[00:21.847]",
    "[00:17.798]你好吗 独自在空无一人的房间里[00:21.847]",
  ].join("\n");

  const { main, trans } = splitCombinedTimeline(combinedExcerpt);
  const format = detectTimedLyricFormat(main);
  const lyrics = await parseLyricsByFormat(format, main, trans);

  assert.equal(format, "enhanced-lrc");
  assert.equal(lyrics.lines.length, 3);
  assert.equal(lyrics.lines[0].fullText, "......");
  assert.equal(lyrics.lines[1].fullText, "ハロ窓を開けて小さく呟いた");
  assert.equal(lyrics.lines[1].translation, "你好 打开窗户轻声说道");
  assert.deepEqual(lyrics.lines[1].words.slice(0, 4).map((word) => word.text), ["ハ", "ロ", "窓", "を"]);
  assert.equal(lyrics.lines[1].words[0].startTime, 12.428);
  assert.equal(lyrics.lines[1].words[0].endTime, 12.667);
});

test("解析 Hello/How are you 夹具中尖括号定时的 enhanced LRC 片段", async () => {
  const combinedExcerpt = [
    "[00:12.428]<00:12.428>ハ<00:12.667>ロ<00:13.343>窓<00:13.548>を<00:13.747>開<00:14.073>け<00:14.449>て<00:15.019>小<00:15.426>さ<00:15.637>く<00:15.794>呟<00:16.024>い<00:16.500>た<00:16.986>",
    "[00:12.428]<00:12.428>你好 打开窗户轻声说道<00:16.986>",
    "[00:17.798]<00:17.798>ハ<00:17.981>ワ<00:18.171>ユ<00:18.380>誰<00:18.528>も<00:18.801>い<00:19.060>な<00:19.463>い<00:20.056>部<00:20.282>屋<00:20.541>で<00:20.800>一<00:21.171>人<00:21.847>",
    "[00:17.798]<00:17.798>你好吗 独自在空无一人的房间里<00:21.847>",
  ].join("\n");

  const { main, trans } = splitCombinedTimeline(combinedExcerpt);
  const format = detectTimedLyricFormat(main);
  const lyrics = await parseLyricsByFormat(format, main, trans);

  assert.equal(format, "enhanced-lrc");
  assert.equal(lyrics.lines.length, 3);
  assert.equal(lyrics.title, undefined);
  assert.equal(lyrics.lines[0].fullText, "......");
  assert.equal(lyrics.lines[1].fullText, "ハロ窓を開けて小さく呟いた");
  assert.equal(lyrics.lines[1].translation, "你好 打开窗户轻声说道");
  assert.deepEqual(lyrics.lines[1].words.slice(0, 4).map((word) => word.text), ["ハ", "ロ", "窓", "を"]);
  assert.equal(lyrics.lines[1].words[2].startTime, 13.343);
  assert.equal(lyrics.lines[1].words[2].endTime, 13.548);
});

test("CJK 主行 + 拉丁音译行归 romanization，CJK 译文行归 translation", () => {
  const { main, trans, romanization } = splitCombinedTimeline(
    "[00:01.00]你好世界\n[00:01.00]nihao shijie\n[00:01.00]HELLO WORLD"
  );

  assert.equal(main, "[00:01.00]你好世界");
  // 两个拉丁候选时，音译须唯一命中才生效：这里 nihao shijie 与 HELLO WORLD 都是拉丁行，
  // 音译候选数 >1 → 不认定 romanization，二者其一作为翻译。
  assert.equal(romanization, "");
  assert.ok(trans.length > 0);
});

// —— findTranslationsForSortedStartTimes ——
const entries = (...pairs) => pairs.map(([startTime, text]) => ({ startTime, text }));

test("不会把翻译借给邻近但没有自身翻译的行", () => {
  assert.deepEqual(findTranslationsForSortedStartTimes([20, 20.6], entries([20, "戊"])), ["戊", undefined]);
});

test("两行同起点时各自拿到自己的翻译", () => {
  assert.deepEqual(
    findTranslationsForSortedStartTimes([10, 10], entries([10, "甲乙"], [10.01, "丙丁"])),
    ["甲乙", "丙丁"]
  );
  assert.deepEqual(
    findTranslationsForSortedStartTimes([10, 10], entries([10, "甲乙"], [10, "丙丁"])),
    ["甲乙", "丙丁"]
  );
});

test("离得最近的行优先认领偏移的翻译", () => {
  assert.deepEqual(findTranslationsForSortedStartTimes([10, 10.5], entries([10.4, "late"])), [undefined, "late"]);
});

test("一秒内整体偏移的翻译轨仍能对齐", () => {
  assert.deepEqual(
    findTranslationsForSortedStartTimes([1, 5, 9], entries([1.3, "a"], [5.3, "b"], [9.3, "c"])),
    ["a", "b", "c"]
  );
  assert.deepEqual(findTranslationsForSortedStartTimes([1], entries([2, "too far"])), [undefined]);
});

test("带翻译行在其后的普通 LRC 导入时保持干净", () => {
  const { main, trans } = splitCombinedTimeline("[00:20.00]Hello\n[00:20.00]戊\n[00:20.60]Yeah");
  const lyrics = parseLRC(main, trans);
  assert.deepEqual(
    lyrics.lines.filter((line) => line.fullText !== "......").map((line) => [line.fullText, line.translation]),
    [["Hello", "戊"], ["Yeah", undefined]]
  );
});

// —— 安全预检（本项目自研封装 index.ts）——
test("安全预检：合法 <?xml?> 声明正常通过并解析", async () => {
  const validTtml = '<?xml version="1.0" encoding="UTF-8"?>' + TTML_ADVANCED_FIXTURE;
  const result = await parseLyrics({ text: validTtml });

  assert.equal(result.rejected, undefined);
  assert.equal(result.empty, false);
  assert.ok(result.data.lines.some((line) => line.fullText === "hurricane 風"));
});

test("安全预检：含 <!DOCTYPE 的输入被拒（不交给解析器）", async () => {
  const result = await parseLyrics({
    text: '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "' + "A".repeat(1024) + '">]><tt/>',
  });

  assert.equal(result.rejected, "entity-declaration");
  assert.equal(result.empty, true);
  assert.equal(result.data.lines.length, 0);
});

test("安全预检：含小写 <!doctype 的输入被拒", async () => {
  const result = await parseLyrics({
    text: '<?xml version="1.0"?><!doctype r [<!entity a "x">]><tt/>',
  });

  assert.equal(result.rejected, "entity-declaration");
  assert.equal(result.empty, true);
});

test("安全预检：<!DOCTYPE 前有 BOM 或空白同样被拒", async () => {
  const withBom = await parseLyrics({ text: "﻿<!DOCTYPE html [<!ENTITY a \"x\">]>" });
  assert.equal(withBom.rejected, "entity-declaration");

  const withLeadingSpace = await parseLyrics({ text: "\n\n   <!ENTITY % a SYSTEM \"evil\">" });
  assert.equal(withLeadingSpace.rejected, "entity-declaration");
});

test("安全预检：含 <!ENTITY 的输入被拒", async () => {
  const result = await parseLyrics({ text: '<tt><!ENTITY % bomb "boom">%bomb;<body/></tt>' });

  assert.equal(result.rejected, "entity-declaration");
  assert.equal(result.empty, true);
  assert.equal(result.data.lines.length, 0);
});

// —— 无歌词归一化（本项目自研封装 index.ts）——
test("归一化：空串与仅元信息标签都判为空，lines 为冻结空数组", async () => {
  const emptyStr = await parseLyrics({ text: "" });
  assert.equal(emptyStr.empty, true);
  assert.equal(emptyStr.rejected, undefined);
  assert.ok(Object.isFrozen(emptyStr.data.lines));
  assert.equal(emptyStr.data.lines.length, 0);

  const metadataOnly = await parseLyrics({ text: "[ti:只标题]\n[ar:只艺术家]\n" });
  assert.equal(metadataOnly.empty, true);
  assert.ok(Object.isFrozen(metadataOnly.data.lines));
  assert.equal(metadataOnly.data.lines.length, 0);
});

test("归一化：解析出的每行都带 isInterlude 标记，间奏合成行为 true", async () => {
  const result = await parseLyrics({ text: "[00:04.00]Hello world\n[00:10.00]再见" });

  assert.equal(result.empty, false);
  assert.ok(result.data.lines.length >= 2);
  assert.ok(result.data.lines.every((line) => typeof line.isInterlude === "boolean"));
  const interludes = result.data.lines.filter((line) => line.isInterlude);
  assert.ok(interludes.length >= 1);
  assert.ok(interludes.every((line) => line.fullText === "......"));
});

// —— 回归：Worker 里的 TTML 解析（2026-10-03 踩坑）——
// Web Worker 作用域没有 DOMParser/document，而 Vite 默认 worker.format="iife" 不允许 worker 内
// 代码分割。原实现「有原生 DOMParser 就用原生，否则 @vite-ignore 动态 import @xmldom/xmldom」，
// 在 Worker 里既取不到原生也解析不了裸标识符，抛错又被 parseLyrics 的降级 catch 吞成「无歌词」，
// 症状只是歌词区一片空白，而 Node 单测全绿。现在固定用静态 import 的 xmldom，锁住这个形状。
test("回归：TTML 解析器固定为静态 import 的 @xmldom/xmldom，主线程/Worker/Node 同一代码路径", async () => {
  const source = readFileSync(new URL("../src/lyrics/parser-core.ts", import.meta.url), "utf8");
  // 只看代码，注释里提到 @vite-ignore / DOMParser 是踩坑说明，不算违规。
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /@vite-ignore/, "不得再把 xmldom 排除出打包");
  assert.doesNotMatch(code, /await import\(/, "worker 里不允许动态 import（worker.format=iife）");
  assert.doesNotMatch(code, /globalThis\.DOMParser/, "不得再按环境分叉选择 XML 解析器");
  assert.ok(
    code.includes(`import { DOMParser as XmlDomParser } from '@xmldom/xmldom'`),
    "TTML 的 XML 解析器要静态引入 @xmldom/xmldom",
  );

  const result = await parseLyrics({ text: TTML_ADVANCED_FIXTURE, format: "ttml" });
  assert.equal(result.error, undefined, "解析成功时不应带降级原因");
  assert.equal(result.empty, false);
  assert.ok(result.data.lines.length >= 1);
  assert.ok(result.data.lines[0].words.length >= 2, "TTML 逐字时间轴要落进 words");
});

// 解析器抛错仍按「无歌词」降级，不外抛、不部分返回，但原因必须可见——
// 静默降级曾把一个真缺陷藏了两个任务。
test("降级：XML 解析抛错时返回无歌词并带出原因，不向外抛", async () => {
  const result = await parseLyrics({ text: "<tt><body><div>", format: "ttml" });
  assert.equal(result.empty, true);
  assert.equal(result.data.lines.length, 0);
  assert.ok(
    (result.error ?? "").includes("unclosed xml tag"),
    `降级要把解析器原因带出去，实际为 ${JSON.stringify(result.error)}`,
  );

  const valid = await parseLyrics({ text: TTML_ADVANCED_FIXTURE, format: "ttml" });
  assert.equal(valid.error, undefined, "正常输入不应带降级原因");
  assert.equal(valid.empty, false);
});

// ── 第四期 R56：parseQRC（在线逐字歌词的格式）──────────────────────────────
// 夹具是**合成**的 legacy QRC（结构与 QQ 真实载荷一致：行首 [startMs,durMs] + 词级 (startMs,durMs[,len])），
// 正文用占位词，不含任何第三方歌词。
const QRC_FIXTURE = [
  '[ti:SYNTHETIC]', '[ar:SYNTHETIC ARTIST]', '[offset:0]',
  '[0,2250]ALPHA(0,160)BETA(160,160) GAMMA(320,160)-DELTA(480,160)',
  '[2250,2250]EPSILON(2250,450)ZETA(2700,450)',
  '[4500,1000]THETA(4500,0)IOTA(4875,120)',
].join(String.fromCharCode(10));

test('R56：QRC 解析出真实字级时间轴，isWordByWord 为真', async () => {
  const { parseLyrics } = await import('../src/lyrics/index.ts');
  const result = await parseLyrics({ text: QRC_FIXTURE, format: 'qrc' });
  assert.equal(result.empty, false);
  assert.equal(result.data.isWordByWord, true);
  const line = result.data.lines[0];
  assert.equal(line.startTime, 0);
  assert.equal(line.words.map((w) => w.text).join(''), line.fullText, '词拼接必须等于整行文本');
  assert.deepEqual(line.words.map((w) => [w.text, w.startTime, w.endTime]), [
    ['ALPHA', 0, 0.16], ['BETA', 0.16, 0.32], [' GAMMA', 0.32, 0.48], ['-DELTA', 0.48, 0.64],
  ]);
});

test('R56：QRC 的零长词标记按上游语义保留（end 不早于 start）', async () => {
  const { parseLyrics } = await import('../src/lyrics/index.ts');
  const result = await parseLyrics({ text: QRC_FIXTURE, format: 'qrc' });
  const theta = result.data.lines[2].words.find((w) => w.text === 'THETA');
  assert.ok(theta, '零长标记的词仍应产出');
  assert.ok(theta.endTime >= theta.startTime, `实测 ${theta.startTime} → ${theta.endTime}`);
});

test('R56：QRC 的译文/罗马音走同一入口，对齐语义沿用上游 findTranslationsForSortedStartTimes', async () => {
  const { parseLyrics } = await import('../src/lyrics/index.ts');
  const NL = String.fromCharCode(10);
  const qrc = ['[ti:X]', '[0,2250]ALPHA(0,160)BETA(160,160)', '[2250,2250]EPSILON(2250,450)', '[4500,1000]THETA(4500,0)'].join(NL);
  const translation = ['[00:01.00]第一行译文', '[00:03.00]第二行译文'].join(NL);
  const result = await parseLyrics({ text: qrc, format: 'qrc', translation, romanization: '[0,2250]A(0,160)B(160,160)' });
  const rows = result.data.lines.map((l) => [l.startTime, l.translation ?? null, l.romanization ?? null]);
  // 实测映射（逐字移植的上游对齐函数给的结果，不是本仓自写规则）：
  //   0.00s → 译文无、罗马音 "AB"；2.25s → 译文 "第二行译文"；4.50s → 两者皆无。
  assert.deepEqual(rows, [
    [0, null, 'AB'],
    [2.25, '第二行译文', null],
    [4.5, null, null],
  ]);
  assert.equal(result.data.isWordByWord, true, '带译文不该改变逐字判定');
});

test('R56：把纯 LRC 交给 qrc 解析会得到 0 行 —— 因此编排层必须先判 isQrcPayload 再选格式', async () => {
  const { parseLyrics } = await import('../src/lyrics/index.ts');
  const { isQrcPayload } = await import('../scripts/online-normalize.mjs');
  const plain = '[00:01.00]AAA' + String.fromCharCode(10) + '[00:05.00]BBB';
  assert.equal(isQrcPayload(plain), false, '判定与解析必须同向：非 QRC 就不该走 qrc');
  const asQrc = await parseLyrics({ text: plain, format: 'qrc' });
  assert.equal(asQrc.data.lines.length, 0, '误用 qrc 解析纯 LRC 会静默丢词（本条钉住为什么要有 isQrcPayload 分流）');
  const asLrc = await parseLyrics({ text: plain, format: 'lrc' });
  assert.equal(asLrc.data.lines.length, 2);
});

test('R56：嗅探器不把 QRC 误判成 enhanced-lrc（两者括号语义不同）', async () => {
  const { detectTimedLyricFormat } = await import('../src/lyrics/format-detection.ts');
  assert.equal(detectTimedLyricFormat(QRC_FIXTURE), 'lrc', 'QRC 交给嗅探会落到 lrc，所以在线路径必须显式带 format');
});
