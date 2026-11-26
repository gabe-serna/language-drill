import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionAudio } from "../src/core/audio.ts";
import { voicevox } from "../src/adapters/voicevox.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("invalid audio from a replacement provider leaves replay unavailable", async () => {
  let unavailable = false;
  const session = sessionAudio(async () => new Uint8Array(12), async () => assert.fail("unexpected playback"));
  session.preload("文");
  session.replay("文", () => { unavailable = true; });
  await tick();
  assert.equal(unavailable, true);
  await session.close();
});

test("prefetch stays silent, repeated play replaces playback and exit stops it", async () => {
  let requests = 0;
  let active = 0;
  let plays = 0;
  const session = sessionAudio(async () => { requests++; return Buffer.from("RIFF0000WAVE"); }, async (_wav, signal) => {
    assert.equal(active++, 0);
    plays++;
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    active--;
  });
  session.preload("文");
  session.preload("文");
  assert.equal(plays, 0);
  session.replay("文", assert.fail);
  await tick();
  session.replay("文", assert.fail);
  await tick();
  assert.equal(plays, 2);
  assert.equal(requests, 1);
  await session.close();
  assert.equal(active, 0);
});

test("leaving feedback while synthesis is pending suppresses late playback", async () => {
  let finish!: (wav: Buffer) => void;
  const session = sessionAudio(() => new Promise(resolve => { finish = resolve; }), async () => assert.fail());
  session.preload("文");
  session.replay("文", assert.fail);
  session.stop();
  finish(Buffer.alloc(1));
  await session.close();
});

test("default style discovery, query text, and synthesis speed", async () => {
  const paths: string[] = [];
  const synth = voicevox({enabled:true,apiAddress:"http://localhost:50021",speakerId:null,speed:1.2,autoPlay:true}, async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/speakers") return Response.json([{name:"玄野武宏",styles:[{name:"ノーマル",id:17}]}]);
    assert.equal(url.searchParams.get("speaker"), "17");
    assert.equal(init?.method, "POST");
    if (url.pathname === "/audio_query") {
      assert.equal(url.searchParams.get("text"), "文");
      return Response.json({speedScale:1});
    }
    assert.equal(JSON.parse(String(init?.body)).speedScale,1.2);
    return new Response("RIFF0000WAVE");
  });
  await synth("文", new AbortController().signal);
  assert.deepEqual(paths, ["/speakers","/audio_query","/synthesis"]);
});
