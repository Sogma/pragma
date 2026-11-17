import { describe, expect, it } from "vitest";
import { parseVideoEmbed } from "../../src/protocol/videoEmbed.ts";

const ID = "dQw4w9WgXcQ";

describe("parseVideoEmbed", () => {
  it("recognizes every YouTube URL form", () => {
    for (const href of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&list=PL123`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}`,
      `http://www.youtube.com/watch?v=${ID}`,
    ]) {
      expect(parseVideoEmbed(href), href).toEqual({ provider: "youtube", id: ID });
    }
  });

  it("reads a start time from t or start, in any of its spellings", () => {
    expect(parseVideoEmbed(`https://youtu.be/${ID}?t=90`)?.start).toBe(90);
    expect(parseVideoEmbed(`https://youtu.be/${ID}?t=90s`)?.start).toBe(90);
    expect(parseVideoEmbed(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)?.start).toBe(90);
    expect(parseVideoEmbed(`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`)?.start).toBe(3723);
    expect(parseVideoEmbed(`https://www.youtube.com/embed/${ID}?start=42`)?.start).toBe(42);
  });

  it("leaves out a start time that is zero or unreadable", () => {
    expect(parseVideoEmbed(`https://youtu.be/${ID}?t=0`)).toEqual({ provider: "youtube", id: ID });
    expect(parseVideoEmbed(`https://youtu.be/${ID}?t=soon`)).toEqual({ provider: "youtube", id: ID });
  });

  it("refuses look-alike hosts, other paths, and malformed ids", () => {
    for (const href of [
      `https://notyoutube.com/watch?v=${ID}`,
      `https://youtube.com.evil.example/watch?v=${ID}`,
      `https://www.youtube.com/@channel`,
      `https://www.youtube.com/playlist?list=PL123`,
      `https://www.youtube.com/watch`,
      `https://www.youtube.com/watch?v=short`,
      `https://youtu.be/${ID}/extra`,
      `javascript:alert(1)//youtu.be/${ID}`,
      `hero.png`,
      `lib:shots/hero.png`,
    ]) {
      expect(parseVideoEmbed(href), href).toBeUndefined();
    }
  });
});
